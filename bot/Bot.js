const path = require('path')
const { createClient } = require('../src/createClient')
const fs = require('fs')

class Bot {
    constructor(name, options = {}) {
        this.name = name
        this.client = null
        this.isConnected = false
        this.isSneaking = false
        this.antiAfkEnabled = false
        this.antiAfkInterval = null
        this.reconnectAttempts = 0
        this.shouldReconnect = true
        this.reconnectTimer = null

        // Configuration from environment or options
        this.config = {
            host: options.host || process.env.SERVER_HOST || 'localhost',
            port: parseInt(options.port || process.env.SERVER_PORT || '19132', 10),
            reconnectDelay: parseInt(process.env.RECONNECT_DELAY || '5000', 10),
            reconnectMaxAttempts: parseInt(process.env.RECONNECT_MAX_ATTEMPTS || '10', 10),
            antiAfkInterval: parseInt(process.env.ANTI_AFK_INTERVAL || '30000', 10)
        }

        // Per-bot auth cache folder
        this.authCacheFolder = path.join(__dirname, '..', 'auth_cache', this.name)
        this._ensureAuthFolder()
    }

    _ensureAuthFolder() {
        if (!fs.existsSync(this.authCacheFolder)) {
            fs.mkdirSync(this.authCacheFolder, { recursive: true })
        }
    }

    _log(message) {
        const timestamp = new Date().toLocaleTimeString()
        console.log(`[${timestamp}] [${this.name}] ${message}`)
    }

    _logChat(sender, message) {
        const timestamp = new Date().toLocaleTimeString()
        console.log(`[${timestamp}] [${this.name}] <${sender}> ${message}`)
    }

    async join(isAuto = false) {
        if (!isAuto) {
            this.reconnectAttempts = 0
            this.shouldReconnect = true
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer)
                this.reconnectTimer = null
            }
        }

        if (this.isConnected) {
            this._log('Already connected!')
            return
        }

        this._log(`Connecting to ${this.config.host}:${this.config.port}...`)

        try {
            this.client = createClient({
                host: this.config.host,
                port: this.config.port,
                username: this.name,
                offline: false,
                profilesFolder: this.authCacheFolder,
                onMsaCode: (data) => {
                    this._log(`Microsoft Login Required!`)
                    this._log(`Open: ${data.verification_uri}`)
                    this._log(`Enter code: ${data.user_code}`)
                }
            })

            this._setupEventHandlers()

        } catch (err) {
            this._log(`Connection error: ${err.message}`)
            this._handleReconnect()
        }
    }

    _setupEventHandlers() {
        // Store player position from start_game
        this.position = { x: 0, y: 64, z: 0 }
        this.rotation = { pitch: 0, yaw: 0 }
        this.tick = 0n
        this.positionLoop = null

        this.client.on('start_game', (packet) => {
            // Try different field names for position (varies by version)
            const pos = packet.player_position || packet.position || packet.spawn_position ||
                { x: packet.x || 0, y: packet.y || 64, z: packet.z || 0 }

            this.position = {
                x: pos.x || 0,
                y: pos.y || 64,
                z: pos.z || 0
            }

            // Get runtime entity ID
            this.runtimeEntityId = packet.runtime_entity_id

            // Debug: log key fields
            this._log(`start_game received:`)
            this._log(`  position: ${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)}`)
            this._log(`  runtime_entity_id: ${this.runtimeEntityId}`)
        })

        // Use respawn packet for more accurate position
        this.client.on('respawn', (packet) => {
            if (packet.player_position || packet.position) {
                const pos = packet.player_position || packet.position
                this.position = {
                    x: pos.x || this.position.x,
                    y: pos.y || this.position.y,
                    z: pos.z || this.position.z
                }
                this._log(`respawn position: ${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)}`)
            }
        })

        this.client.on('spawn', () => {
            this._log('Spawned in world!')
            this.isConnected = true
            this.reconnectAttempts = 0

            // Start sending position updates to stay visible
            this._startPositionLoop()
        })

        this.client.on('move_player', (packet) => {
            if (packet.runtime_id === this.runtimeEntityId) {
                this.position = {
                    x: packet.position.x,
                    y: packet.position.y,
                    z: packet.position.z
                }
                this.rotation = {
                    pitch: packet.pitch || 0,
                    yaw: packet.yaw || 0
                }
            }
        })

        // Inventory management
        this.inventory = [] // standard inventory (window 0)
        this.heldItemSlot = 0
        this.currentWindow = null // { id, type, items: [] }
        this.windows = {} // Track all window contents dynamically

        // Auto-Buy flow state
        // 0: inactive
        // 1: waiting for Main Shop
        // 2: waiting for Shard Shop
        // 3: waiting for Confirm page
        // 4: waiting for purchase result text
        this.autoBuyState = 0
        this.isAutoBuying = false
        this.autoBuyClickedWindows = new Set()
        this.autoBuyAttempts = 0
        this.autoBuyShopRetryTimer = null
        this.autoBuyShopRetryCount = 0

        this.client.on('container_open', (packet) => {
            this._log(`Container opened: ID ${packet.window_id}, Type ${packet.window_type}`)
            this.currentWindow = {
                id: packet.window_id,
                type: packet.window_type,
                items: []
            }

            if (this.isAutoBuying) {
                // New windows can reuse IDs. Reset per-window click guard on each open.
                this.autoBuyClickedWindows.delete(String(packet.window_id))

                // Fallback attempt if content is already present.
                setTimeout(() => {
                    this._processAutoBuyWindow(packet.window_id)
                }, 300)
            }
        })

        this.client.on('container_close', (packet) => {
            if (this.currentWindow && this.currentWindow.id === packet.window_id) {
                this._log(`Container closed: ID ${packet.window_id} (server: ${packet.server})`)
                this.currentWindow = null
            }

            if (this.isAutoBuying) {
                this.autoBuyClickedWindows.delete(String(packet.window_id))
            }

            // When the server initiates the close (server: true), we MUST respond
            // with our own container_close, otherwise the server won't open the next GUI
            if (packet.server === true) {
                this.client.queue('container_close', {
                    window_id: packet.window_id,
                    window_type: packet.window_type || 'none',
                    server: false
                })
                this._log(`Responded to server-initiated container_close for window ${packet.window_id}`)
            }
        })

        this.client.on('inventory_content', (packet) => {
            // Unconditionally store the inventory content based on window_id
            this.windows[packet.window_id] = packet.input.map(item => item)

            if (packet.window_id === 'inventory' || packet.window_id === 0) {
                this.inventory = packet.input.map(item => item)
            } else if (this.currentWindow && packet.window_id === this.currentWindow.id) {
                this.currentWindow.items = packet.input.map(item => item)
                this._log(`Received container content (${this.currentWindow.items.length} items)`)
            }

            // Important: some servers send inventory_content before/without container_open.
            if (this.isAutoBuying && !this._isPlayerInventoryWindow(packet.window_id)) {
                this._processAutoBuyWindow(packet.window_id)
            }
        })

        this.client.on('inventory_slot', (packet) => {
            if (!this.windows[packet.window_id]) {
                this.windows[packet.window_id] = []
            }
            this.windows[packet.window_id][packet.slot] = packet.item

            if (packet.window_id === 'inventory' || packet.window_id === 0) {
                if (packet.slot < this.inventory.length) {
                    this.inventory[packet.slot] = packet.item
                }
            } else if (this.currentWindow && packet.window_id === this.currentWindow.id) {
                if (packet.slot < this.currentWindow.items.length) {
                    this.currentWindow.items[packet.slot] = packet.item
                }
            }
        })

        this.client.on('mob_equipment', (packet) => {
            if (packet.runtime_entity_id === this.runtimeEntityId) {
                this.heldItemSlot = packet.selected_slot
                // this._log(`Selected slot updated to ${this.heldItemSlot}`)
            }
        })

        this.client.on('correct_player_move_prediction', (packet) => {
            if (packet.position) {
                this.position = {
                    x: packet.position.x,
                    y: packet.position.y,
                    z: packet.position.z
                }
            }
        })

        this.client.on('text', (packet) => {
            const sender = packet.source_name || 'Server'
            const message = packet.message || ''
            const isChatLike = packet.type === 'chat' || packet.type === 'whisper' || packet.type === 'announcement'

            if (isChatLike) {
                if (sender !== this.name) {
                    this._logChat(sender, message)
                }
                return
            }

            this._log(`[System] ${message}`)

            // Emergency Disconnect Check
            if (message.includes('WARNING: Servers are updating, do not teleport or you will lose your location, you will be put back shortly.!')) {
                this._emergencyQueueReconnect()
            }

            if (!this.isAutoBuying) return

            const normalizedMessage = this._normalizeGuiText(message)
            const compactMessage = normalizedMessage
                .replace(/[’'`]/g, '')
                .replace(/[^a-z0-9\s]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()

            const purchaseSuccess = compactMessage.includes('you received') &&
                compactMessage.includes('skeleton') &&
                compactMessage.includes('spawner')

            const outOfShards = /you\s+(dont|do not)\s+have\s+enough\s+shards?/.test(compactMessage)

            if (purchaseSuccess) {
                this._log('[AutoBuy] Purchase successful! Continuing loop...')
                // Purchase resolved. Next actionable menu is Shard Shop.
                this.autoBuyState = 2
                this.autoBuyClickedWindows.clear()
                this._stopAutoBuyShopOpenRetries()
            } else if (outOfShards) {
                this._log('[AutoBuy] Out of shards. Stopping auto-buy.')
                this.isAutoBuying = false
                this.autoBuyState = 0
                this.autoBuyAttempts = 0
                this.autoBuyClickedWindows.clear()
                this._stopAutoBuyShopOpenRetries()
                // Close any remaining open container
                if (this.currentWindow) {
                    this.client.queue('container_close', {
                        window_id: this.currentWindow.id,
                        window_type: 'none',
                        server: false
                    })
                    this.currentWindow = null
                }
            }
        })

        this.client.on('kick', (packet) => {
            this._log(`Kicked: ${packet.message}`)
            this._stopPositionLoop()
            this.isConnected = false
            this._handleReconnect()
        })

        this.client.on('close', () => {
            this._stopPositionLoop()
            this._log('Disconnected from server')
            this.isConnected = false

            // Always try to reconnect if enabled, even if we never fully connected (e.g. ping timeout)
            if (this.shouldReconnect) {
                this._handleReconnect()
            }
        })

        this.client.on('error', (err) => {
            if (err.message && err.message.includes('Read error')) {
                return
            }

            const isTimeout = err.message && err.message.includes('Ping timed out')
            if (isTimeout) {
                this._log(`Error: Ping timed out (Network unstable)`)
            } else {
                this._log(`Error: ${err.message}`)
            }

            // If we are not connected and get an error (like timeout), we need to retry immediately
            // The close event might not fire or might fire later, so we handle it here
            if (!this.isConnected && this.shouldReconnect) {
                this.client.removeAllListeners('close')
                this._handleReconnect()
            }
        })
    }

    _startPositionLoop() {
        if (this.positionLoop) return

        // Send position updates every 50ms (20 ticks per second like Minecraft)
        this.positionLoop = setInterval(() => {
            if (this.isConnected && this.client) {
                this._sendPositionUpdate()
            }
        }, 50)
    }

    _stopPositionLoop() {
        if (this.positionLoop) {
            clearInterval(this.positionLoop)
            this.positionLoop = null
        }
    }

    _sendPositionUpdate() {
        if (!this.positionUpdateCount) this.positionUpdateCount = 0

        try {
            const sneakFlag = this.isSneaking ? 0x2000n : 0n

            // Log first few position updates for debugging
            if (this.positionUpdateCount < 3) {
                this._log(`Sending position update #${this.positionUpdateCount + 1}: pos=(${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)}), tick=${this.tick}`)
            }

            this.client.queue('player_auth_input', {
                pitch: this.rotation.pitch,
                yaw: this.rotation.yaw,
                position: this.position,
                move_vector: { x: 0, z: 0 },
                head_yaw: this.rotation.yaw,
                input_data: { _value: sneakFlag },
                input_mode: 'mouse',
                play_mode: 'screen',
                interaction_model: 'touch',
                interact_rotation: { x: 0, z: 0 },
                tick: this.tick++,
                delta: { x: 0, y: 0, z: 0 },
                analogue_move_vector: { x: 0, z: 0 },
                camera_orientation: { x: 0, y: 0, z: 0 },
                raw_move_vector: { x: 0, z: 0 }
            })

            this.positionUpdateCount++
        } catch (err) {
            // Log errors - this is important for debugging
            this._log(`Position update error: ${err.message}`)
            console.error(err)
        }
    }

    _handleReconnect() {
        if (!this.shouldReconnect) {
            this._log('Reconnect disabled')
            return
        }

        if (this.reconnectTimer) {
            return
        }

        if (this.reconnectAttempts >= this.config.reconnectMaxAttempts) {
            this._log(`Max reconnect attempts (${this.config.reconnectMaxAttempts}) reached`)
            return
        }

        this.reconnectAttempts++
        this._log(`Reconnecting in ${this.config.reconnectDelay / 1000}s... (attempt ${this.reconnectAttempts}/${this.config.reconnectMaxAttempts})`)

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.join(true)
        }, this.config.reconnectDelay)
    }

    _emergencyQueueReconnect() {
        this._log('!!! EMERGENCY DISCONNECT TRIGGERED !!!')
        this._log('Server update warning received. Disconnecting immediately.')
        this._log('Will reconnect in 5 minutes...')

        // Force disconnect
        this.leave()

        // Manually set shouldReconnect to true because leave() sets it to false
        this.shouldReconnect = true

        // Schedule reconnect for 5 minutes (300,000 ms)
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this._log('Emergency wait over. Reconnecting...')
            this.join(true)
        }, 300000) // 5 minutes
    }

    leave() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
            this._log('Cancelled pending reconnect')
        }

        this.shouldReconnect = false

        if (!this.client) {
            this._log('Not connected (no client)')
            return
        }
        this._stopPositionLoop()
        this.stopAntiAfk()
        this.client.disconnect('Leaving')
        this.isConnected = false
        this._log('Disconnected')
    }

    chat(message) {
        if (!this.isConnected || !this.client) {
            this._log('Not connected, cannot send chat')
            return
        }

        this.client.queue('text', {
            type: 'chat',
            needs_translation: false,
            source_name: this.name,
            xuid: '',
            platform_chat_id: '',
            message: message,
            category: 'authored',
            chat: '',
            whisper: '',
            announcement: '',
            has_filtered_message: false
        })
        this._log(`Sent: ${message}`)
    }

    sneak() {
        if (!this.isConnected || !this.client) {
            this._log('Not connected, cannot toggle sneak')
            return
        }

        // Toggle sneak flag - position loop will send it with next update
        this.isSneaking = !this.isSneaking
        this._log(`Sneak ${this.isSneaking ? 'enabled' : 'disabled'}`)
    }

    getInventory() {
        if (!this.inventory || this.inventory.length === 0) {
            this._log('Inventory is empty or not loaded yet')
            return []
        }

        const items = []
        this.inventory.forEach((item, index) => {
            if (item.network_id !== 0) { // 0 usually means air/empty
                items.push({ slot: index, id: item.network_id, count: item.count, metadata: item.metadata })
            }
        })
        return items
    }

    selectSlot(slotId) {
        if (!this.isConnected || !this.client) return

        slotId = parseInt(slotId)
        if (isNaN(slotId) || slotId < 0 || slotId > 8) {
            this._log('Invalid slot (must be 0-8 for hotbar)')
            return
        }

        // Send mob_equipment packet
        // We need to find the item in that slot to send it properly, 
        // though server might just trust the slot number.
        const item = this.inventory[slotId] || { network_id: 0, count: 0, metadata: 0, block_runtime_id: 0, extra: { name: 'default', params: { nbt: { version: 1 } } } }

        this.client.queue('mob_equipment', {
            runtime_entity_id: this.runtimeEntityId,
            item: item,
            slot: slotId,
            selected_slot: slotId,
            window_id: 'inventory' // or 'main_hand' depending on context, usually 'inventory' (0) for hotbar
        })
        this.heldItemSlot = slotId
        this._log(`Selected slot ${slotId}`)
    }

    useItem() {
        if (!this.isConnected || !this.client) return

        const item = this.inventory[this.heldItemSlot]
        // Allow using air if needed (sometimes interacts work with empty hand)

        // simple item_use transaction
        const transaction = {
            legacy: { legacy_request_id: 0 },
            transaction_type: 'item_use',
            actions: [],
            transaction_data: {
                action_type: 'interact',
                hotbar_slot: this.heldItemSlot,
                held_item: item || { network_id: 0, count: 0, metadata: 0, block_runtime_id: 0, extra: { name: 'default', params: { nbt: { version: 1 } } } },
                player_pos: this.position,
                click_pos: { x: 0, y: 0, z: 0 },
                block_runtime_id: 0,
                client_prediction: 'failure'
            }
        }

        this.client.queue('inventory_transaction', {
            transaction: transaction
        })
        this._log('Used item')
    }

    dropSelectedItem() {
        if (!this.isConnected || !this.client) {
            this._log('Not connected, cannot drop item')
            return
        }

        this.client.queue('interact', {
            action_id: 'open_inventory',
            target_entity_id: this.runtimeEntityId || 0n
        })
        this._log('Sent open_inventory interact to scan for Spawner items')

        // Give the server time to open/refresh inventory before scanning slots.
        setTimeout(() => {
            if (!this.isConnected || !this.client) return

            const targets = this._collectSpawnerDropTargets()
            if (targets.length === 0) {
                this._log('No Spawner item found in inventory')
                this.client.queue('container_close', {
                    window_id: 'inventory',
                    window_type: 'none',
                    server: false
                })
                this._log('Sent container_close for inventory')
                return
            }

            const totalCount = targets.reduce((sum, target) => sum + target.count, 0)
            this._log(`[Drop] Found ${targets.length} Spawner stack(s), total ${totalCount}. Dropping now...`)

            targets.forEach((target, index) => {
                setTimeout(() => {
                    if (!this.isConnected || !this.client) return

                    const requestId = -(Number(this.tick % 100000n) + 1 + index)
                    try {
                        this.client.queue('item_stack_request', {
                            requests: [
                                {
                                    request_id: requestId,
                                    actions: [
                                        {
                                            type_id: 'drop',
                                            count: target.count,
                                            source: {
                                                slot_type: { container_id: target.containerId },
                                                slot: target.slot,
                                                stack_id: target.stackId
                                            },
                                            randomly: false
                                        }
                                    ],
                                    custom_names: [],
                                    cause: -1
                                }
                            ]
                        })
                        this._log(`[Drop] Sent drop for slot ${target.slot} (${target.containerId}) x${target.count}, stack_id ${target.stackId}`)
                    } catch (err) {
                        this._log(`[Drop] Failed to send drop for slot ${target.slot}: ${err.message}`)
                    }
                }, index * 170)
            })

            const closeDelay = targets.length * 170 + 550
            setTimeout(() => {
                if (!this.isConnected || !this.client) return
                this.client.queue('container_close', {
                    window_id: 'inventory',
                    window_type: 'none',
                    server: false
                })
                this._log('Sent container_close for inventory')
            }, closeDelay)
        }, 450)
    }

    _isSpawnerItem(item) {
        if (!item || item.network_id === 0) return false

        const display = this._extractDisplayNameAndLore(item)
        const normalizedDisplay = `${display.name} ${display.lore}`.trim()
        if (normalizedDisplay.includes('spawner')) return true

        const fallbackName = this._normalizeGuiText(item.name || item.custom_name || item.display_name || '')
        if (fallbackName.includes('spawner')) return true

        return item.network_id === 52
    }

    _collectSpawnerDropTargets() {
        const targets = []
        if (!Array.isArray(this.inventory)) return targets

        for (let slot = 0; slot < this.inventory.length; slot++) {
            const item = this.inventory[slot]
            if (!this._isSpawnerItem(item)) continue

            const count = Number(item.count) || 0
            if (count <= 0) continue

            targets.push({
                slot,
                count,
                stackId: item.stack_id || 0,
                containerId: slot <= 8 ? 'hotbar' : 'inventory'
            })
        }

        return targets
    }

    getContainerItems() {
        if (!this.currentWindow || !this.currentWindow.items) {
            return []
        }
        const items = []
        this.currentWindow.items.forEach((item, index) => {
            if (item.network_id !== 0) {
                items.push({ slot: index, id: item.network_id, count: item.count, metadata: item.metadata })
            }
        })
        return items
    }

    clickContainerSlot(slotId) {
        if (!this.isConnected || !this.client) return
        if (!this.currentWindow) {
            this._log('No container open to click')
            return
        }

        slotId = parseInt(slotId)
        const item = this.currentWindow.items[slotId]
        if (!item || item.network_id === 0) {
            this._log(`Slot ${slotId} is empty`)
            return
        }

        // Transaction: Pick up item from Container -> Cursor (Window 124)
        const emptyItem = { network_id: 0, count: 0, metadata: 0, block_runtime_id: 0, extra: { name: 'default', params: { nbt: { version: 1 } } } }

        const actionTake = {
            source_type: 0, // Container
            inventory_id: this.currentWindow.id,
            slot: slotId,
            old_item: item,
            new_item: emptyItem
        }

        const actionPlaceCursor = {
            source_type: 0, // Container
            inventory_id: 124, // Cursor Window ID
            slot: 0, // Cursor has only 1 slot usually
            old_item: emptyItem,
            new_item: item
        }

        const transaction = {
            legacy: { legacy_request_id: 0 },
            transaction_type: 'normal',
            actions: [actionTake, actionPlaceCursor],
            transaction_data: null
        }

        this.client.queue('inventory_transaction', {
            transaction: transaction
        })
        this._log(`Clicked slot ${slotId} in window ${this.currentWindow.id}`)
    }

    afk() {
        if (!this.isConnected || !this.client) {
            this._log('Not connected, cannot use afk command')
            return
        }
        this._log('Sending /afk and waiting for AFK GUI...')
        // Use command_request for consistency with servers that do not treat chat as command.
        this.client.queue('command_request', {
            command: '/afk',
            origin: {
                type: 'player',
                uuid: '00000000-0000-0000-0000-000000000000',
                request_id: '',
                player_entity_id: this.runtimeEntityId || 0n
            },
            internal: false,
            version: '72'
        })
        const maxAttempts = 10
        let attempts = 0
        const tryFindAndClick = () => {
            if (!this.isConnected || !this.client) return
            attempts++
            const target = this._findAfkTarget()
            if (!target) {
                if (attempts < maxAttempts) {
                    setTimeout(tryFindAndClick, 300)
                } else {
                    this._log('[AFK] Could not find AFK option in open containers.')
                }
                return
            }
            this._log(`[AFK] Clicking slot ${target.slot} in window ${target.windowId} (${target.mode})`)
            this._sendItemClick(target.slot, target.windowId)
            // Close shortly after clicking so server can process selection.
            setTimeout(() => {
                if (!this.isConnected || !this.client) return
                this.client.queue('container_close', {
                    window_id: target.windowId,
                    window_type: 'none',
                    server: false
                })
                this._log(`[AFK] Sent container_close for window ${target.windowId}`)
                if (this.currentWindow && this.currentWindow.id === target.windowId) {
                    this.currentWindow = null
                }
                delete this.windows[target.windowId]
            }, 450)
        }
        // First probe shortly after command, then retry if GUI is delayed.
        setTimeout(tryFindAndClick, 350)
    }
    _normalizeGuiText(text) {
        return String(text || '')
            .replace(/\u00c2/g, '')
            .replace(/\u00a7./g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
    }

    _extractDisplayNameAndLore(item) {
        const empty = { name: '', lore: '' }
        if (!item || item.network_id === 0) return empty

        const display = item.extra?.nbt?.value?.display?.value ||
            item.extra?.nbt?.nbt?.value?.display?.value

        const fallbackName = item.name || item.custom_name || item.display_name || ''
        const name = this._normalizeGuiText(display?.Name?.value || fallbackName || '')
        const loreValues = display?.Lore?.value?.value
        const lore = Array.isArray(loreValues)
            ? loreValues
                .map(entry => this._normalizeGuiText(entry?.value ?? entry ?? ''))
                .filter(Boolean)
                .join(' ')
            : ''

        return { name, lore }
    }

    _isPlayerInventoryWindow(windowId) {
        const id = String(windowId)
        return id === 'inventory' || id === 'armor' || id === 'offhand' || id === 'ui' ||
            id === '0' || id === '119' || id === '120' || id === '124' || id === '-1' || id === 'none'
    }

    _isAfkLabel(text) {
        return text.includes('afk')
    }

    _findAfkTarget() {
        let bestNonFull = null
        let bestAny = null

        for (const [windowId, items] of Object.entries(this.windows)) {
            if (this._isPlayerInventoryWindow(windowId)) continue
            if (!Array.isArray(items) || items.length === 0) continue

            let candidateAny = null
            let candidateNonFull = null
            let afkMatches = 0
            let afkTextMatches = 0

            for (let i = 0; i < items.length; i++) {
                const item = items[i]
                if (!item || item.network_id === 0) continue

                const display = this._extractDisplayNameAndLore(item)
                const text = `${display.name} ${display.lore}`
                const hasAfkText = this._isAfkLabel(text)
                if (hasAfkText) afkTextMatches++
                const isAfkEntry = hasAfkText || item.network_id === 152
                if (!isAfkEntry) continue

                afkMatches++
                const isFull = text.includes('full')
                const candidate = { windowId, slot: i, afkMatches }

                if (!candidateAny) candidateAny = candidate
                if (!isFull && !candidateNonFull) candidateNonFull = candidate
            }

            // Guard against random containers that happen to contain a few redstone blocks.
            if (afkTextMatches === 0 && afkMatches < 10) continue

            if (candidateNonFull && (!bestNonFull || candidateNonFull.afkMatches > bestNonFull.afkMatches)) {
                bestNonFull = candidateNonFull
            }
            if (candidateAny && (!bestAny || candidateAny.afkMatches > bestAny.afkMatches)) {
                bestAny = candidateAny
            }
        }

        if (bestNonFull) return { ...bestNonFull, mode: 'non-full AFK' }
        if (bestAny) return { ...bestAny, mode: 'fallback AFK' }

        // Final fallback for known AFK menu layout in packets.log
        if (this.windows.first && Array.isArray(this.windows.first) && this.windows.first[49] && this.windows.first[49].network_id !== 0) {
            return { windowId: 'first', slot: 49, mode: 'slot 49 fallback' }
        }

        return null
    }

    _findSlotByKeywords(items, keywordGroups) {
        if (!Array.isArray(items)) return -1

        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            if (!item || item.network_id === 0) continue

            const display = this._extractDisplayNameAndLore(item)
            const searchable = `${display.name} ${display.lore}`

            for (const group of keywordGroups) {
                if (group.every(keyword => searchable.includes(keyword))) {
                    return i
                }
            }
        }

        return -1
    }

    _processAutoBuyWindow(windowId) {
        if (!this.isAutoBuying || !this.isConnected || !this.client) return
        if (this.autoBuyState === 0) return
        const windowKey = String(windowId)
        if (this.autoBuyClickedWindows.has(windowKey)) return
        const items = this.windows[windowId] || this.currentWindow?.items
        if (!Array.isArray(items) || items.length === 0) return

        const idAt = (slot) => {
            const item = items[slot]
            return item && item.network_id ? item.network_id : 0
        }
        const spawnerBandCount = [9, 10, 11, 12, 13, 14, 15, 16, 17]
            .reduce((acc, slot) => acc + (idAt(slot) === 52 ? 1 : 0), 0)
        const looksLikeMainShop = idAt(15) === 660
        const looksLikeShardShop = idAt(13) === 52 && spawnerBandCount >= 5
        const looksLikeConfirm = idAt(13) === 52 && idAt(15) !== 0 && idAt(11) !== 0 && !looksLikeShardShop

        const shardShopSlot = this._findSlotByKeywords(items, [['shard', 'shop']])
        const skeletonSlot = this._findSlotByKeywords(items, [['spawner', 'skeleton'], ['skeleton', 'spawner']])
        const confirmSlot = this._findSlotByKeywords(items, [['confirm']])
        let targetSlot = -1
        let targetLabel = ''

        // Prefer deterministic menu signatures from packet flow.
        if (looksLikeMainShop) {
            targetSlot = 15
            targetLabel = 'Shard Shop (main menu)'
            this.autoBuyState = 2
        } else if (looksLikeShardShop) {
            targetSlot = 13
            targetLabel = 'Spawner Skeleton (shard menu)'
            this.autoBuyState = 3
        } else if (looksLikeConfirm) {
            targetSlot = 15
            targetLabel = 'Confirm (confirm menu)'
            // Wait for result text before proceeding.
            this.autoBuyState = 4
            this.autoBuyAttempts++
        } else if (this.autoBuyState === 1) {
            targetSlot = shardShopSlot !== -1 ? shardShopSlot : 15
            targetLabel = shardShopSlot !== -1 ? 'Shard Shop' : 'Shard Shop (fallback)'
            this.autoBuyState = 2
        } else if (this.autoBuyState === 2) {
            targetSlot = skeletonSlot !== -1 ? skeletonSlot : 13
            targetLabel = skeletonSlot !== -1 ? 'Spawner Skeleton' : 'Spawner Skeleton (fallback)'
            this.autoBuyState = 3
        } else if (this.autoBuyState === 3) {
            targetSlot = confirmSlot !== -1 ? confirmSlot : 15
            targetLabel = confirmSlot !== -1 ? 'Confirm' : 'Confirm (fallback)'
            // Wait for system text before next buy decision to avoid double-buy when shards are 0.
            this.autoBuyState = 4
            this.autoBuyAttempts++
        } else if (this.autoBuyState === 4) {
            // Recovery path when result text is delayed/missed: continue from detected menu.
            if (skeletonSlot !== -1) {
                targetSlot = skeletonSlot
                targetLabel = 'Spawner Skeleton (recover)'
                this.autoBuyState = 3
            } else if (shardShopSlot !== -1) {
                targetSlot = 13
                targetLabel = 'Spawner Skeleton (recover fallback)'
                this.autoBuyState = 3
            }
        }

        if (this.autoBuyAttempts > 2000) {
            this._log('[AutoBuy] Safety stop: too many attempts without stopping condition.')
            this.isAutoBuying = false
            this.autoBuyState = 0
            this.autoBuyAttempts = 0
            this.autoBuyClickedWindows.clear()
            return
        }
        if (targetSlot < 0) return
        this.autoBuyClickedWindows.add(windowKey)
        if (this.autoBuyState !== 1) {
            this._stopAutoBuyShopOpenRetries()
        }
        this._log(`[AutoBuy] Clicking slot ${targetSlot} (${targetLabel}) in window ${windowId}`)
        this._sendItemClick(targetSlot, windowId)
    }

    _sendShopCommand() {
        if (!this.isConnected || !this.client) return
        this.client.queue('command_request', {
            command: '/shop',
            origin: {
                type: 'player',
                uuid: '00000000-0000-0000-0000-000000000000',
                request_id: '',
                player_entity_id: this.runtimeEntityId || 0n
            },
            internal: false,
            version: '72'
        })
        this._log('Sent /shop command via command_request')
    }

    _stopAutoBuyShopOpenRetries() {
        if (this.autoBuyShopRetryTimer) {
            clearInterval(this.autoBuyShopRetryTimer)
            this.autoBuyShopRetryTimer = null
        }
    }

    _startAutoBuyShopOpenRetries() {
        this._stopAutoBuyShopOpenRetries()
        this.autoBuyShopRetryCount = 0

        this.autoBuyShopRetryTimer = setInterval(() => {
            if (!this.isAutoBuying || !this.isConnected || !this.client) {
                this._stopAutoBuyShopOpenRetries()
                return
            }

            // Stop retrying once we're past waiting-for-main-shop.
            if (this.autoBuyState !== 1) {
                this._stopAutoBuyShopOpenRetries()
                return
            }

            this.autoBuyShopRetryCount++
            if (this.autoBuyShopRetryCount > 5) {
                this._log('[AutoBuy] Shop GUI did not open after retries. Stopping auto-buy.')
                this.isAutoBuying = false
                this.autoBuyState = 0
                this.autoBuyAttempts = 0
                this.autoBuyClickedWindows.clear()
                this._stopAutoBuyShopOpenRetries()
                return
            }

            this._log(`[AutoBuy] Waiting for shop GUI... retry ${this.autoBuyShopRetryCount}/5`)
            this._sendShopCommand()
        }, 1200)
    }

    _sendItemClick(slot, exactWindowId) {
        if (!this.isConnected || !this.client) return

        let targetStackId = 0
        if (this.windows[exactWindowId] && this.windows[exactWindowId][slot]) {
            targetStackId = this.windows[exactWindowId][slot].stack_id || 0
        }

        this.client.queue('item_stack_request', {
            requests: [
                {
                    request_id: -Number(this.tick % 100000n),
                    actions: [
                        {
                            type_id: 'take',
                            count: 1,
                            source: {
                                slot_type: { container_id: 'container' },
                                slot: slot,
                                stack_id: targetStackId
                            },
                            destination: {
                                slot_type: { container_id: 'cursor' },
                                slot: 0,
                                stack_id: 0
                            }
                        }
                    ],
                    custom_names: [],
                    cause: -1
                }
            ]
        })
        this._log(`Sent item_stack_request for window ID ${exactWindowId}, slot ${slot} (stack_id: ${targetStackId})`)
    }

    buySkeletonSpawner() {
        if (!this.isConnected || !this.client) {
            this._log('Cannot auto-buy: not connected to spawn')
            return
        }
        this._log('Starting Auto-Buy sequence for Skeleton Spawners...')
        this.isAutoBuying = true
        this.autoBuyState = 1
        this.autoBuyAttempts = 0
        this.autoBuyClickedWindows.clear()
        this.autoBuyShopRetryCount = 0
        this._startAutoBuyShopOpenRetries()

        // Optional packet debug for auto-buy investigation.
        // Enable only when needed: set AUTOBUY_DEBUG_PKTS=1
        if (process.env.AUTOBUY_DEBUG_PKTS === '1') {
            const interestingPackets = new Set([
                'container_open',
                'container_close',
                'inventory_content',
                'inventory_slot',
                'text',
                'item_stack_response',
                'command_output'
            ])

            const debugHandler = (packet) => {
                const name = packet?.data?.name
                if (name && interestingPackets.has(name)) {
                    this._log(`[DEBUG PKT] ${name}`)
                }
            }

            this.client.on('packet', debugHandler)
            setTimeout(() => {
                this.client.removeListener('packet', debugHandler)
                this._log('[DEBUG] Auto-buy packet logging stopped after 15s')
            }, 15000)
        }

        // Small delay to let previous GUI/close packets settle before opening shop.
        setTimeout(() => {
            if (!this.isAutoBuying) return
            this._sendShopCommand()
        }, 300)
    }

    startAntiAfk() {
        if (this.antiAfkEnabled) {
            this._log('Anti-AFK already enabled')
            return
        }

        this.antiAfkEnabled = true
        this._log('Anti-AFK enabled')

        // Anti-AFK sends small random movements periodically
        this.antiAfkInterval = setInterval(() => {
            if (this.isConnected && this.client) {
                try {
                    // Send a small jump by adding ASCEND flag to next position update
                    const jumpFlag = 0x1n  // ASCEND flag
                    const sneakFlag = this.isSneaking ? 0x2000n : 0n

                    this.client.queue('player_auth_input', {
                        pitch: this.rotation.pitch,
                        yaw: this.rotation.yaw,
                        position: this.position,
                        move_vector: { x: 0.01, z: 0 },  // Tiny movement
                        head_yaw: this.rotation.yaw,
                        input_data: { _value: jumpFlag | sneakFlag },
                        input_mode: 'mouse',
                        play_mode: 'screen',
                        interaction_model: 'touch',
                        interact_rotation: { x: 0, z: 0 },
                        tick: this.tick++,
                        delta: { x: 0, y: 0, z: 0 },
                        analogue_move_vector: { x: 0, z: 0 },
                        camera_orientation: { x: 0, y: 0, z: 0 },
                        raw_move_vector: { x: 0, z: 0 }
                    })
                } catch (err) {
                    // Ignore errors in anti-afk
                }
            }
        }, this.config.antiAfkInterval)
    }

    stopAntiAfk() {
        if (!this.antiAfkEnabled) {
            return
        }

        this.antiAfkEnabled = false
        if (this.antiAfkInterval) {
            clearInterval(this.antiAfkInterval)
            this.antiAfkInterval = null
        }
        this._log('Anti-AFK disabled')
    }

    toggleAntiAfk() {
        if (this.antiAfkEnabled) {
            this.stopAntiAfk()
        } else {
            this.startAntiAfk()
        }
    }
}

module.exports = Bot




