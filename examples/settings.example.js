module.exports = {
    flowFile: 'flows.json',
    uiPort: process.env.PORT || 1880,

    // Development only: the examples ask for a real provider key in the model node.
    credentialSecret: false,

    logging: {
        console: { level: 'info', metrics: false, audit: false }
    },

    editorTheme: {
        projects: { enabled: false }
    },

    // Environment variables this package can read. Node-RED's own environment is what a typed
    // value of type `env` resolves against; the server's process.env is not used.
    env: {
        // Example: the model node can pick `env` and write MODEL_API_KEY to read this.
        MODEL_API_KEY: '',
        // Example: an MCP header can be `Authorization: Bearer $MCP_TOKEN`.
        MCP_TOKEN: ''
    }
};
