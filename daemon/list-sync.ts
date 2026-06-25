import { PLATFORM, TOKEN } from './config.js'
import { threadRegistry } from './sessions.js'
import type { ThreadInfo } from './sessions.js'

const LIST_ID = process.env.SLACK_LIST_ID ?? 'F0BCRUGNMM2'
const ENABLED = PLATFORM === 'slack' && !!TOKEN && !!LIST_ID

let columnIds: Record<string, string> | null = null

async function slackListsApi(method: string, body: Record<string, unknown>): Promise<any> {
  if (!ENABLED) return null
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    })
    const data = await res.json() as any
    if (!data.ok) {
      process.stderr.write(`list-sync: ${method} failed: ${data.error}\n`)
    }
    return data
  } catch (err) {
    process.stderr.write(`list-sync: ${method} error: ${err}\n`)
    return null
  }
}

async function ensureColumnIds(): Promise<Record<string, string>> {
  if (columnIds) return columnIds
  const data = await slackListsApi('slackLists.columns.list', { list_id: LIST_ID })
  if (!data?.ok || !data.columns) return {}
  columnIds = {}
  for (const col of data.columns as Array<{ id: string; key?: string; name?: string }>) {
    const key = col.key ?? col.name ?? col.id
    columnIds[key] = col.id
  }
  process.stderr.write(`list-sync: discovered ${Object.keys(columnIds).length} column(s)\n`)
  return columnIds
}

function richText(text: string) {
  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }],
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function syncSpawn(
  thread: ThreadInfo,
  sessionName: string,
  originType?: string,
  originFrom?: string,
): Promise<void> {
  if (!ENABLED) return
  try {
    const cols = await ensureColumnIds()
    if (!cols.Name) return

    const fields: Array<{ column_id: string; [key: string]: unknown }> = [
      { column_id: cols.Name, rich_text: richText(thread.topic) },
    ]

    if (cols.thread_date) fields.push({ column_id: cols.thread_date, date: [today()] })
    if (cols.status) fields.push({ column_id: cols.status, select: ['Active'] })
    if (cols.session_name) fields.push({ column_id: cols.session_name, rich_text: richText(sessionName) })
    if (cols.todo_completed) fields.push({ column_id: cols.todo_completed, checkbox: false })
    if (cols.thread_link && thread.threadUrl) fields.push({ column_id: cols.thread_link, message: thread.threadUrl })
    if (cols.origin && originType) fields.push({ column_id: cols.origin, select: [originType] })
    if (cols.origin_from && originFrom) fields.push({ column_id: cols.origin_from, rich_text: richText(originFrom) })

    const data = await slackListsApi('slackLists.items.create', {
      list_id: LIST_ID,
      initial_fields: fields,
    })

    if (data?.ok && data.item?.id) {
      thread.listRecordId = data.item.id
      threadRegistry.persist()
      process.stderr.write(`list-sync: created item ${data.item.id} for ${sessionName}\n`)
    }
  } catch (err) {
    process.stderr.write(`list-sync: syncSpawn failed: ${err}\n`)
  }
}

export async function syncKill(thread: ThreadInfo): Promise<void> {
  if (!ENABLED || !thread.listRecordId) return
  try {
    const cols = await ensureColumnIds()
    const cells: Array<{ column_id: string; row_id: string; [key: string]: unknown }> = []
    if (cols.status) cells.push({ column_id: cols.status, row_id: thread.listRecordId, select: ['Completed'] })
    if (cols.todo_completed) cells.push({ column_id: cols.todo_completed, row_id: thread.listRecordId, checkbox: true })
    if (cells.length === 0) return
    await slackListsApi('slackLists.items.update', { list_id: LIST_ID, cells })
    process.stderr.write(`list-sync: marked ${thread.listRecordId} completed\n`)
  } catch (err) {
    process.stderr.write(`list-sync: syncKill failed: ${err}\n`)
  }
}

export async function syncCrash(thread: ThreadInfo): Promise<void> {
  if (!ENABLED || !thread.listRecordId) return
  try {
    const cols = await ensureColumnIds()
    if (!cols.status) return
    await slackListsApi('slackLists.items.update', {
      list_id: LIST_ID,
      cells: [{ column_id: cols.status, row_id: thread.listRecordId, select: ['Crashed'] }],
    })
    process.stderr.write(`list-sync: marked ${thread.listRecordId} crashed\n`)
  } catch (err) {
    process.stderr.write(`list-sync: syncCrash failed: ${err}\n`)
  }
}

export async function syncResume(thread: ThreadInfo, sessionName: string): Promise<void> {
  if (!ENABLED || !thread.listRecordId) return
  try {
    const cols = await ensureColumnIds()
    const cells: Array<{ column_id: string; row_id: string; [key: string]: unknown }> = []
    if (cols.status) cells.push({ column_id: cols.status, row_id: thread.listRecordId, select: ['Active'] })
    if (cols.session_name) cells.push({ column_id: cols.session_name, row_id: thread.listRecordId, rich_text: richText(sessionName) })
    if (cols.todo_completed) cells.push({ column_id: cols.todo_completed, row_id: thread.listRecordId, checkbox: false })
    if (cells.length === 0) return
    await slackListsApi('slackLists.items.update', { list_id: LIST_ID, cells })
    process.stderr.write(`list-sync: resumed ${thread.listRecordId} as ${sessionName}\n`)
  } catch (err) {
    process.stderr.write(`list-sync: syncResume failed: ${err}\n`)
  }
}

export async function syncUpdate(thread: ThreadInfo, fields: {
  contextPct?: number
  messageCount?: number
  duration?: string
}): Promise<void> {
  if (!ENABLED || !thread.listRecordId) return
  try {
    const cols = await ensureColumnIds()
    const cells: Array<{ column_id: string; row_id: string; [key: string]: unknown }> = []
    if (cols.context_pct != null && fields.contextPct != null) {
      cells.push({ column_id: cols.context_pct, row_id: thread.listRecordId, number: [fields.contextPct] })
    }
    if (cols.message_count != null && fields.messageCount != null) {
      cells.push({ column_id: cols.message_count, row_id: thread.listRecordId, number: [fields.messageCount] })
    }
    if (cols.duration && fields.duration) {
      cells.push({ column_id: cols.duration, row_id: thread.listRecordId, rich_text: richText(fields.duration) })
    }
    if (cells.length === 0) return
    await slackListsApi('slackLists.items.update', { list_id: LIST_ID, cells })
  } catch (err) {
    process.stderr.write(`list-sync: syncUpdate failed: ${err}\n`)
  }
}

export const _test = { richText, today }
