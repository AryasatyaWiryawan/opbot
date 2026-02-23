const { Relay } = require('bedrock-protocol')
const fs = require('fs')

const DESTINATION_HOST = process.env.RELAY_DEST_HOST || 'donutsmp.net'
const DESTINATION_PORT = Number(process.env.RELAY_DEST_PORT || 19132)
const LISTEN_PORT = Number(process.env.RELAY_LISTEN_PORT || 19132)
const LOG_FILE = process.env.RELAY_LOG_FILE || 'packets.log'

// Keep each run clean by default.
const APPEND_LOG = process.env.RELAY_APPEND_LOG === '1'
if (!APPEND_LOG) fs.writeFileSync(LOG_FILE, '')

console.log('Starting Relay...')
console.log(`Client connect: 127.0.0.1:${LISTEN_PORT}`)
console.log(`Forwarding to : ${DESTINATION_HOST}:${DESTINATION_PORT}`)
console.log(`Log file      : ${LOG_FILE}`)
console.log('Logging only item interactions + chat/system messages + GUI/container packets')

const relay = new Relay({
  host: '0.0.0.0',
  port: LISTEN_PORT,
  destination: {
    host: DESTINATION_HOST,
    port: DESTINATION_PORT
  },
  version: '1.21.111'
})

relay.conLog = console.debug

const CLIENTBOUND_ALLOWED = new Set([
  'text',
  'command_output',
  'container_open',
  'container_close',
  'inventory_content',
  'inventory_slot',
  'item_stack_response'
])

const SERVERBOUND_ALLOWED = new Set([
  'text',
  'command_request',
  'item_stack_request',
  'inventory_transaction',
  'container_close',
  'interact'
])

function normalizeText(text) {
  return String(text || '').replace(/\u00c2/g, '')
}

function parseDisplay(item) {
  const display = item?.extra?.nbt?.value?.display?.value ||
    item?.extra?.nbt?.nbt?.value?.display?.value
  const rawName = display?.Name?.value
  return rawName ? normalizeText(rawName) : undefined
}

function simplifyItem(item, slotHint) {
  if (!item || item.network_id === 0) return null
  const out = {
    id: item.network_id
  }
  if (typeof slotHint === 'number') out.slot = slotHint
  if (typeof item.count === 'number') out.count = item.count
  if (typeof item.stack_id === 'number') out.stack_id = item.stack_id
  const name = parseDisplay(item)
  if (name) out.name = name
  return out
}

function simplifyInventoryContent(params) {
  const input = Array.isArray(params?.input) ? params.input : []
  const nonEmpty = []
  for (let i = 0; i < input.length; i++) {
    const compact = simplifyItem(input[i], i)
    if (compact) nonEmpty.push(compact)
  }

  return {
    window_id: params.window_id,
    total_slots: input.length,
    non_empty_count: nonEmpty.length,
    items: nonEmpty
  }
}

function simplifyItemStackRequest(params) {
  const requests = Array.isArray(params?.requests) ? params.requests : []
  return {
    requests: requests.map(req => ({
      request_id: req.request_id,
      actions: Array.isArray(req.actions) ? req.actions.map(action => ({
        type_id: action.type_id,
        count: action.count,
        source: action.source ? {
          container_id: action.source?.slot_type?.container_id,
          slot: action.source?.slot,
          stack_id: action.source?.stack_id
        } : undefined,
        destination: action.destination ? {
          container_id: action.destination?.slot_type?.container_id,
          slot: action.destination?.slot,
          stack_id: action.destination?.stack_id
        } : undefined
      })) : []
    }))
  }
}

function simplifyPacket(direction, name, params) {
  if (name === 'text') {
    return {
      type: params.type,
      source_name: params.source_name,
      message: normalizeText(params.message)
    }
  }

  if (name === 'command_request') {
    return { command: params.command }
  }

  if (name === 'command_output') {
    return {
      success_count: params.success_count,
      output: params.output
    }
  }

  if (name === 'container_open') {
    return {
      window_id: params.window_id,
      window_type: params.window_type,
      coordinates: params.coordinates
    }
  }

  if (name === 'container_close') {
    return {
      window_id: params.window_id,
      window_type: params.window_type,
      server: params.server
    }
  }

  if (name === 'inventory_content') {
    return simplifyInventoryContent(params)
  }

  if (name === 'inventory_slot') {
    return {
      window_id: params.window_id,
      slot: params.slot,
      item: simplifyItem(params.item, params.slot)
    }
  }

  if (name === 'item_stack_request') {
    return simplifyItemStackRequest(params)
  }

  if (name === 'item_stack_response') {
    return params
  }

  if (name === 'inventory_transaction') {
    return {
      transaction_type: params?.transaction?.transaction_type,
      action_count: Array.isArray(params?.transaction?.actions) ? params.transaction.actions.length : 0
    }
  }

  if (name === 'interact') {
    return {
      action_id: params.action_id,
      target_entity_id: params.target_entity_id
    }
  }

  return params
}

function stringifyForLog(value) {
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)
}

function writePacket(direction, name, params) {
  const time = new Date().toISOString()
  const simplified = simplifyPacket(direction, name, params)
  const line = `\n[${time}] [${direction}] ${name}: ${stringifyForLog(simplified)}`
  console.log(line)
  fs.appendFileSync(LOG_FILE, `${line}\n`)
}

relay.on('connect', player => {
  console.log('Player connected:', player.connection.address)

  player.on('error', err => {
    console.error('Player error:', err)
  })

  player.on('close', () => {
    console.log('Player connection closed.')
  })

  player.on('kick', reason => {
    console.log('Player kicked! Reason:', reason)
  })

  player.on('clientbound', ({ name, params }) => {
    if (!CLIENTBOUND_ALLOWED.has(name)) return
    writePacket('Server -> Client', name, params)
  })

  player.on('serverbound', ({ name, params }) => {
    if (!SERVERBOUND_ALLOWED.has(name)) return

    // Skip noisy mouse-over spam while still allowing real interactions.
    if (name === 'interact' && params?.action_id === 'mouse_over_entity') return

    writePacket('Client -> Server', name, params)
  })
})

relay.listen()
