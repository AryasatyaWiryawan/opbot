#!/usr/bin/env node

/**
 * Multi-Client Bedrock Bot System
 * 
 * Usage:
 *   node bot/index.js
 * 
 * Commands:
 *   .join          - Connect all bots to server
 *   .leave         - Disconnect all bots
 *   .chat <msg>    - Send chat message from all bots
 *   .sneak         - Toggle sneak on all bots
 *   .antiafk       - Toggle anti-AFK on all bots
 *   .status        - Show status of all bots
 *   .help          - Show help message
 * 
 * Targeting specific bot:
 *   @bot1 .join    - Connect only bot1
 *   @bot2 .chat Hi - Send chat from bot2 only
 */

require('dotenv').config()
const readline = require('readline')
const BotManager = require('./BotManager')

// Initialize bot manager
const manager = new BotManager()

// Get bot names from environment
const botNames = (process.env.BOT_NAMES || 'bot1').split(',').map(n => n.trim()).filter(n => n)

console.log(`
╔════════════════════════════════════════════════════════════╗
║         Multi-Client Bedrock Protocol Bot System            ║
╠════════════════════════════════════════════════════════════╣
║  Server: ${(process.env.SERVER_HOST || 'localhost').padEnd(47)}║
║  Port:   ${(process.env.SERVER_PORT || '19132').padEnd(47)}║
╚════════════════════════════════════════════════════════════╝
`)

// Create bots from configuration
console.log('Creating bots...')
for (const name of botNames) {
    manager.addBot(name)
}

console.log(`\nCreated ${botNames.length} bot(s): ${botNames.join(', ')}`)
console.log('\nType .help for available commands\n')

// Set up readline interface for CLI input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
})

rl.prompt()

rl.on('line', async (line) => {
    const input = line.trim()

    if (!input) {
        rl.prompt()
        return
    }

    // Handle .help specially
    if (input === '.help') {
        manager.showHelp()
        rl.prompt()
        return
    }

    // Handle .exit
    if (input === '.exit' || input === '.quit') {
        console.log('Disconnecting all bots...')
        for (const bot of manager.getAllBots()) {
            bot.leave()
        }
        console.log('Goodbye!')
        process.exit(0)
    }

    // Process command
    await manager.handleInput(input)
    rl.prompt()
})

rl.on('close', () => {
    console.log('\nShutting down...')
    for (const bot of manager.getAllBots()) {
        bot.shouldReconnect = false
        if (bot.isConnected) {
            bot.leave()
        }
    }
    process.exit(0)
})

// Handle process termination
process.on('SIGINT', () => {
    console.log('\nReceived SIGINT. Shutting down...')
    rl.close()
})

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message)
})

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err.message)
})
