import { getAppConfig, getControledMihomoConfig } from '../config'
import { getRuntimeConfigStr } from '../core/factory'
import { encryptAgeText } from '../utils/age'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

interface GistInfo {
  id: string
  description: string
  html_url: string
}

const GIST_DESCRIPTION = 'Auto Synced Sparkle Runtime Config'
const GIST_FILE_NAME = 'sparkle.yaml'
const GIST_ENCRYPTED_FILE_NAME = 'sparkle.yaml.age'

function getGistFileName(encrypted: boolean): string {
  return encrypted ? GIST_ENCRYPTED_FILE_NAME : GIST_FILE_NAME
}

function getStaleGistFileName(encrypted: boolean): string {
  return encrypted ? GIST_FILE_NAME : GIST_ENCRYPTED_FILE_NAME
}

async function getGistUploadContent(): Promise<{
  content: string
  encrypted: boolean
  fileName: string
}> {
  const { gistEncrypted = false, gistAgeRecipient = '' } = await getAppConfig()
  const config = await getRuntimeConfigStr()
  const normalizedConfig = config.replace(/\r\n/g, '\n')
  const content = gistEncrypted ? await encryptAgeText(normalizedConfig, gistAgeRecipient) : normalizedConfig

  // 过滤掉所有不可见控制字符（保留 \n \r \t），只保留可打印字符
  const sanitizedContent = content.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

  return {
    content: sanitizedContent,
    encrypted: gistEncrypted,
    fileName: getGistFileName(gistEncrypted)
  }
}

function curlRequest(method: string, url: string, token: string, body: unknown): Promise<string> {
  const tmpFile = join(process.env.TEMP || '/tmp', `gist-body-${Date.now()}.json`)
  const bodyJson = JSON.stringify(body)
  writeFileSync(tmpFile, bodyJson)
  
  try {
    const cmd = [
      'curl -s',
      `-X ${method}`,
      `"${url}"`,
      '-H "Content-Type: application/json"',
      `-H "Authorization: Bearer ${token}"`,
      '-H "User-Agent: Sparkle-App"',
      '-H "Accept: application/vnd.github+json"',
      '-H "X-GitHub-Api-Version: 2022-11-28"',
      body ? `-d @${tmpFile}` : ''
    ].filter(Boolean).join(' ')
    
    console.log(`[Gist] Curl ${method}:`, url, 'body size:', bodyJson.length)
    return Promise.resolve(execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }))
  } finally {
    unlinkSync(tmpFile)
  }
}

async function listGists(token: string): Promise<GistInfo[]> {
  const result = await new Promise<string>((resolve, reject) => {
    const { exec } = require('child_process')
    exec(`curl -s "https://api.github.com/gists" -H "Authorization: Bearer ${token}" -H "User-Agent: Sparkle-App" -H "Accept: application/vnd.github+json"`, (error: Error | null, stdout: string) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
  return JSON.parse(result)
}

async function createGist(token: string, fileName: string, content: string): Promise<void> {
  const body = {
    description: GIST_DESCRIPTION,
    public: false,
    files: { [fileName]: { content } }
  }
  await curlRequest('POST', 'https://api.github.com/gists', token, body)
}

async function updateGist(
  token: string,
  id: string,
  fileName: string,
  content: string,
  encrypted: boolean
): Promise<void> {
  const body = {
    description: GIST_DESCRIPTION,
    files: {
      [fileName]: { content }
    }
  }
  await curlRequest('PATCH', `https://api.github.com/gists/${id}`, token, body)
}

export async function getGistUrl(): Promise<string> {
  const { githubToken, gistSyncEnabled = Boolean(githubToken) } = await getAppConfig()
  if (!gistSyncEnabled) return ''
  if (!githubToken) return ''
  const gists = await listGists(githubToken)
  const gist = gists.find((gist) => gist.description === GIST_DESCRIPTION)
  if (gist) {
    await uploadRuntimeConfig()  // 有旧 Gist 时也同步更新
    return gist.html_url
  } else {
    await uploadRuntimeConfig()
    const gists = await listGists(githubToken)
    const gist = gists.find((gist) => gist.description === GIST_DESCRIPTION)
    if (!gist) throw new Error('Gist not found')
    return gist.html_url
  }
}

export async function uploadRuntimeConfig(): Promise<void> {
  const { githubToken, gistSyncEnabled = Boolean(githubToken) } = await getAppConfig()
  if (!gistSyncEnabled) return
  if (!githubToken) return
  
  try {
    const gists = await listGists(githubToken)
    const gist = gists.find((gist) => gist.description === GIST_DESCRIPTION)
    const { content, encrypted, fileName } = await getGistUploadContent()
    
    console.log('[Gist] Uploading:', {
      fileName,
      contentLength: content.length,
      encrypted,
      isExisting: !!gist,
      gistId: gist?.id
    })
    
    if (gist) {
      await updateGist(githubToken, gist.id, fileName, content, encrypted)
    } else {
      await createGist(githubToken, fileName, content)
    }
  } catch (error: unknown) {
    const axiosError = error as { message?: string }
    console.error('[Gist] Upload failed:', {
      message: axiosError.message
    })
    throw error
  }
}