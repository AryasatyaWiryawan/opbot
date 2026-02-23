const { createProtocol } = require('./src/datatypes/compiler-minecraft');

try {
    const compiler = createProtocol('1.21.120');
    const buffer1 = compiler.createPacketBuffer('command_request', {
        command: '/afk',
        origin: {
            type: 'player',
            uuid: '',
            request_id: ''
        },
        internal: false,
        version: 88
    });
    console.log("Empty UUID works!");
} catch (err) {
    console.error("Empty UUID failed:", err.message);
}

try {
    const compiler = createProtocol('1.21.120');
    const buffer2 = compiler.createPacketBuffer('command_request', {
        command: '/afk',
        origin: {
            type: 'player',
            uuid: '64484174-7bc6-5a96-3930-55c776376aa0',
            request_id: ''
        },
        internal: false,
        version: 88
    });
    console.log("Normal UUID works!");
} catch (err) {
    console.error("Normal UUID failed:", err.message);
}
