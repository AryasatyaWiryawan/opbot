const Bot = require('./Bot')

class BotManager {
    constructor() {
        this.bots = new Map()
    }

    addBot(name, options = {}) {
        if (this.bots.has(name)) {
            console.log(`Bot "${name}" already exists`)
            return this.bots.get(name)
        }

        const bot = new Bot(name, options)
        this.bots.set(name, bot)
        console.log(`Bot "${name}" created`)
        return bot
    }

    getBot(name) {
        return this.bots.get(name)
    }

    getAllBots() {
        return Array.from(this.bots.values())
    }

    getBotNames() {
        return Array.from(this.bots.keys())
    }

    /**
     * Execute a command on all bots sequentially
     * @param {string} command - Command name
     * @param {string[]} args - Command arguments
     */
    async executeOnAll(command, args = []) {
        const bots = this.getAllBots()

        for (const bot of bots) {
            await this.executeCommand(command, args, bot.name)
            // Small delay between bots to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500))
        }
    }

    /**
     * Execute a command on a specific bot
     * @param {string} command - Command name
     * @param {string[]} args - Command arguments
     * @param {string} botName - Target bot name
     */
    async executeCommand(command, args = [], botName = null) {
        const bot = botName ? this.getBot(botName) : null

        if (botName && !bot) {
            console.log(`Bot "${botName}" not found`)
            return
        }

        const targetBots = bot ? [bot] : this.getAllBots()

        for (const b of targetBots) {
            switch (command.toLowerCase()) {
                case 'join':
                    await b.join()
                    break

                case 'leave':
                    b.leave()
                    break

                case 'chat':
                    if (args.length > 0) {
                        b.chat(args.join(' '))
                    } else {
                        console.log('Usage: .chat <message>')
                    }
                    break

                case 'sneak':
                    b.sneak()
                    break

                case 'afk':
                    b.afk()
                    break

                case 'antiafk':
                    b.toggleAntiAfk()
                    break

                case 'status':
                    console.log(`[${b.name}] Connected: ${b.isConnected}, Sneaking: ${b.isSneaking}, AntiAFK: ${b.antiAfkEnabled}`)
                    break

                case 'inventory':
                case 'i':
                    const items = b.getInventory()
                    if (items.length === 0) {
                        console.log(`[${b.name}] Inventory empty`)
                    } else {
                        console.log(`[${b.name}] Inventory:`)
                        items.forEach(item => {
                            console.log(`  Slot ${item.slot}: ID ${item.id} (Count: ${item.count})`)
                        })
                    }
                    break

                case 'select':
                case 'slot':
                    if (args.length > 0) {
                        b.selectSlot(args[0])
                    } else {
                        console.log('Usage: .select <slot_number>')
                    }
                    break

                case 'use':
                    b.useItem()
                    break

                case 'drop':
                    b.dropSelectedItem()
                    break

                case 'container':
                case 'gui':
                case 'shop': // User alias for shop
                    if (!b.currentWindow) {
                        console.log(`[${b.name}] No container open`)
                    } else {
                        const cItems = b.getContainerItems()
                        console.log(`[${b.name}] Container ID ${b.currentWindow.id} (Type ${b.currentWindow.type}):`)
                        if (cItems.length === 0) {
                            console.log('  <Empty>')
                        } else {
                            cItems.forEach(item => {
                                console.log(`  Slot ${item.slot}: ID ${item.id} (Count: ${item.count})`)
                            })
                        }
                    }
                    break

                case 'buy':
                    b.buySkeletonSpawner()
                    break

                case 'click':
                    if (args.length > 0) {
                        b.clickContainerSlot(args[0])
                    } else {
                        console.log('Usage: .click <slot_number>')
                    }
                    break

                default:
                    // If it matches a chat message, it's already handled, 
                    // but here we are in the switch for commands starting with .
                    console.log(`Unknown command: ${command}`)
                    return
            }

            // Small delay between bots when executing on all
            if (!botName && targetBots.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 500))
            }
        }
    }

    /**
     * Parse and execute a raw input command
     * @param {string} input - Raw input string from CLI
     */
    async handleInput(input) {
        const trimmed = input.trim()
        if (!trimmed) return

        let targetBot = null
        let commandStr = trimmed

        // Check for @botname prefix for specific targeting
        const targetMatch = trimmed.match(/^@(\w+)\s+(.+)$/)
        if (targetMatch) {
            targetBot = targetMatch[1]
            commandStr = targetMatch[2]
        }

        // Check for . prefix for commands
        if (!commandStr.startsWith('.')) {
            // Treat as chat message
            commandStr = `.chat ${commandStr}`
        }

        // Parse command and arguments
        const parts = commandStr.slice(1).split(/\s+/)
        const command = parts[0]
        const args = parts.slice(1)

        if (targetBot) {
            // Execute on specific bot
            await this.executeCommand(command, args, targetBot)
        } else {
            // Execute on all bots sequentially
            await this.executeOnAll(command, args)
        }
    }

    showHelp() {
        console.log(`
    ╔════════════════════════════════════════════════════════════╗
    ║               Multi-Client Bot Commands                     ║
    ╠════════════════════════════════════════════════════════════╣
    ║  .join          - Connect all bots to server                ║
    ║  .leave         - Disconnect all bots                       ║
    ║  .chat <msg>    - Send chat message from all bots           ║
    ║  .sneak         - Toggle sneak on all bots                  ║
    ║  .antiafk       - Toggle anti-AFK on all bots               ║
    ║  .inventory     - List bot inventory                        ║
    ║  .gui           - List open container (shop) items          ║
    ║  .select <slot> - Select hotbar slot (0-8)                  ║
    ║  .click <slot>  - Click item in open container              ║
    ║  .use           - Use held item                             ║
    ║  .drop          - Drop all "Spawner" stacks in inventory    ║
    ║  .buy           - Auto-buy Skeleton Spawners until broke    ║
    ║  .status        - Show status of all bots                   ║
    ║  .help          - Show this help message                    ║
    ╠════════════════════════════════════════════════════════════╣
    ║  @botname .cmd  - Execute command on specific bot           ║
    ║  Example: @bot1 .join                                       ║
    ║  Example: @bot2 .chat Hello!                                ║
    ╚════════════════════════════════════════════════════════════╝
    `)
    }
}

module.exports = BotManager
