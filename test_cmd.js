const { createSerializer } = require('./src/transforms/serializer')
const Options = require('./src/options')

const versions = Object.keys(Options.Versions).sort()
const results = []

for (const version of versions) {
    try {
        const ser = createSerializer(version)
        ser.createPacketBuffer({
            name: 'command_request',
            params: {
                command: '/shop',
                origin: { type: 'player', uuid: '00000000-0000-0000-0000-000000000000', request_id: '' },
                internal: false,
                version: 72
            }
        })
        results.push(`${version}: OK`)
    } catch (e) {
        results.push(`${version}: FAIL`)
    }
}

require('fs').writeFileSync('version_results.txt', results.join('\n'))
console.log('Done. Results in version_results.txt')
