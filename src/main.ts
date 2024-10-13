import * as dgram from "dgram"
import * as https from "https"
import express from "express"
import { Socket as SocketIOSocket, Server as SocketIOServer } from "socket.io"

// Satisfactory server has self-signed certificate
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"

const satisfactoryConfig = {
    host: "your-server-ip",
    port: 7777,
    password: "your-password",
    api_path: "/api/v1/"
}

const POLL_INTERVAL = 2000
const UDP_RECONNECT_INTERVAL = 5000

export interface ServerState {
    activeSessionName: string
    numConnectedPlayers: number
    playerLimit: number
    techTier: number
    activeSchematic: string
    gamePhase: string
    isGameRunning: boolean
    totalGameDuration: number
    isGamePaused: boolean
    averageTickRate: number
    autoLoadSessionName: string
}

let serverState: ServerState | null = null
let subStateVersions: Map<number, number> = new Map()
let authToken: string | null = null
let udpSocket: dgram.Socket | null = null
let pollingInterval: NodeJS.Timeout | null = null
let udpReconnectTimeout: NodeJS.Timeout | null = null

const app = express()
const httpServer = app.listen(3001, () => {
    console.log("Server listening on port 3001")
})
const io = new SocketIOServer(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
})

/*
 * UDP API Functions
 */

function createUdpSocket() {
    udpSocket = dgram.createSocket("udp4")

    udpSocket.on("message", (msg, info) => {
        // console.log(`Received ${msg.length} bytes from ${info.address}:${info.port}:`)
        // console.log(msg.toString("hex"))

        const protocolMagic = msg.readUInt16LE(0)
        const messageType = msg.readUInt8(2)

        if (protocolMagic !== 0xF6D5) {
            console.error('Invalid protocol magic! This is not a Satisfactory server response.')
            return
        }

        if (messageType !== 1) {
            console.log(`Received unexpected message type: ${messageType}`)
            return
        }

        const serverState = msg.readUInt8(12) // Read server state
        const serverNetChangeList = msg.readUInt32LE(13) // Read server net changelist
        const numSubStates = msg.readUInt8(25)
        const subStates = []
        let offset = 26 // Start offset for SubStates

        for (let i = 0; i < numSubStates; i++) {
            const subStateId = msg.readUInt8(offset)
            const subStateVersion = msg.readUInt16LE(offset + 1)

            subStates.push({ id: subStateId, version: subStateVersion })
            offset += 3 // Each SubState entry is 3 bytes
        }

        // Detect and handle changes
        let stateChangeDetected = false
        for (const subState of subStates) {
            const prevVersion = subStateVersions.get(subState.id)
            if (prevVersion !== undefined && subState.version !== prevVersion) {
                const subStateId = subState.id
                console.log(`Change detected in SubState ID ${subStateId}`)

                if (subStateId == 0) {
                    stateChangeDetected = true
                }
            }
            subStateVersions.set(subState.id, subState.version)
        }

        if (stateChangeDetected) {
            console.log("State change detected")
            updateServerState().catch((err) => {
                console.error("Error updating server state:", err)
            })
        }
    })

    udpSocket.on("error", (err) => {
        console.error("UDP socket error:", err)
        udpSocket?.close()
        udpSocket = null
        retryUdpConnection()
    })

    udpSocket.on("close", () => {
        console.log("UDP socket closed")
        udpSocket = null
        retryUdpConnection()
    })
}

function retryUdpConnection() {
    console.log("Attempting to reconnect UDP socket in", UDP_RECONNECT_INTERVAL / 1000, "seconds...")
    if (udpReconnectTimeout) {
        clearTimeout(udpReconnectTimeout)
    }
    udpReconnectTimeout = setTimeout(() => {
        createUdpSocket()
        if (udpSocket) {
            startPolling()
        }
    }, UDP_RECONNECT_INTERVAL)
}


/*
 * HTTPS API Functions
 */

async function fetchFromServer(functionName: string, data?: object): Promise<any> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ function: functionName, data })
        const req = https.request({
            hostname: satisfactoryConfig.host,
            port: satisfactoryConfig.port,
            path: satisfactoryConfig.api_path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                ...(authToken && { Authorization: `Bearer ${authToken}` })
            },
        }, (res) => {
            let data = ""
            res.on("data", (chunk) => data += chunk)
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data))
                    } catch (err) {
                        reject(err)
                    }
                } else {
                    reject(new Error(`Request failed with status code: ${res.statusCode}`))
                }
            })
        })

        req.on("error", reject)
        req.write(body)
        req.end()
    })
}

async function authenticate(): Promise<void> {
    try {
        const res = await fetchFromServer("PasswordLogin", {
            MinimumPrivilegeLevel: "Client",
            Password: satisfactoryConfig.password,
        })
        authToken = res.data.authenticationToken
    } catch (err) {
        console.error("Authentication failed:", err)
    }
}

async function updateServerState(): Promise<void> {
    try {
        if (!authToken) {
            await authenticate()
        }
        const res = await fetchFromServer("QueryServerState")
        const oldServerState = serverState
        serverState = res.data.serverGameState

        const changes = compareObjects(oldServerState, serverState, [
            "numConnectedPlayers",
            "techTier",
            "isGameRunning",
            "isGamePaused"
        ])

        if (Object.keys(changes).length !== 0) {
            broadcastState()
        }
    } catch (err) {
        console.error("Error updating server state:", err)
    }
}

/*
 * Socket.IO Event Handlers
 */

io.on("connection", (ioSocket: SocketIOSocket) => {
    console.log("Client connected:", ioSocket.id)

    if (serverState) {
        ioSocket.emit("serverUpdate", serverState)
    } else {
        // If no clients are connected yet, fetch the initial state
        updateServerState()
    }

    if (!pollingInterval) {
        startPolling()
    }

    ioSocket.on("disconnect", () => {
        console.log("Client disconnected:", ioSocket.id)
        if (io.engine.clientsCount === 1) {
            stopPolling()
        }
    })
})

function broadcastState() {
    if (serverState) {
        console.log("Broadcasting state")
        io.emit("serverUpdate", serverState)
    }
}

/*
 * UDP Polling Functions
 */

function startPolling() {
    if (pollingInterval || !udpSocket) return

    console.log("Starting UDP polling...")
    pollServerState()
    pollingInterval = setInterval(pollServerState, POLL_INTERVAL)
}

function stopPolling() {
    if (pollingInterval) {
        console.log("Stopping UDP polling...")
        clearInterval(pollingInterval)
        pollingInterval = null
    }
}

function pollServerState() {
    if (!udpSocket) return

    const message = Buffer.alloc(13)
    message.writeUInt16LE(0xF6D5, 0) // ProtocolMagic
    message.writeUInt8(0, 2)         // MessageType: 0 (Poll Server State)
    message.writeUInt8(1, 3)         // ProtocolVersion: 1
    message.writeBigUInt64LE(BigInt(Date.now()), 4) // Using timestamp as cookie
    message.writeUInt8(0x1, 12)      // Terminator Byte

    udpSocket.send(message, satisfactoryConfig.port, satisfactoryConfig.host, (err) => {
        if (err) {
            console.error("Error sending UDP request:", err)
        } else {
            // console.log("Polling UDP message sent")
        }
    })

}

function compareObjects(obj1: any, obj2: any, fields: string[]): { [key: string]: { old: any, new: any } } {
    const changes: { [key: string]: { old: any, new: any } } = {}

    fields.forEach((field) => {
        if (obj1?.[field] !== obj2?.[field]) {
            changes[field] = {
                old: obj1?.[field] ?? null,
                new: obj2?.[field] ?? null
            }
        }
    })

    return changes
}

// Initial UDP socket creation
createUdpSocket() 