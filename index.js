const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');
const io_client = require("socket.io-client");
const cors = require('cors');
const { networkInterfaces } = require('os');

const { Packet, requestType } = require('./protocol.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const localAddresses = Object.values(networkInterfaces()).map(interface => interface[1].address);

const PORT = process.env.PORT | 5000; 

app.use(bodyParser.json());
app.use(cors());

app.get('/', async (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/protocol.js', async (req, res) => {
    res.sendFile(__dirname + '/protocol.js');
});

app.get('/style.css', async (req, res) => {
    res.sendFile(__dirname + '/style.css');
});

app.get('/socket.io/socket.io.js', (req, res) => {
    res.sendFile(__dirname + '/node_modules/socket.io/client-dist/socket.io.js');
});

let owner;
let clients = {};
let connections = {}; // external

const parseIP = (socket) => {
    const address_components = socket.handshake.address.split(':');
    return address_components[address_components.length - 1];
};

const getConnection = async (host) => {
    if (!connections[host]) {
        connections[host] = io_client(`ws://${host}`);
        connections[host].on('disconnect', () => {
            if (!connections[host]) {
                return;
            }
            console.log(`Connection lost with ${host}`);
            for (let ack of Object.values(connections[host].acks)) {
                ack(new Uint8Array(0));
            }
            delete connections[host];
        });
        return await new Promise((resolve, reject) => {
            connections[host].once('connect', () => resolve());
            connections[host].once('connect_error', (error) => reject(error));
        }).then(() => connections[host]).catch(() => { delete connections[host]; return undefined; });
    } else {
        return connections[host];
    }
};

io.on('connection', (socket) => {
    const ip_address = parseIP(socket);

    if (localAddresses.includes(ip_address)) {
        if (owner) {
            return socket.disconnect();
        }
        socket.owner = true;
        owner = socket;
        console.log('Owner connected');
    } else {
        if (!owner) {
            return socket.disconnect();
        }

        const connected = Object.values(clients).filter(client => parseIP(client) == parseIP(socket));
        if (connected.length > 0) {
            for (let client of connected) {
                client.disconnect();
            }
            return socket.disconnect();
        }

        clients[socket.id] = socket;
        console.log(`Client connected from ip ${ip_address}`);
    }

    console.log(owner != undefined? parseIP(owner) : 'Owner hasn\'t connected yet');
    console.log(Object.values(clients).map(client => parseIP(client)));

    socket.on('disconnect', (reason) => {
        if (socket.owner) {
            for (let client of Object.values(clients)) {
                client.disconnect();
            }
            clients = {};
            owner = undefined;
        } else {
            delete clients[socket.id];
        }
        console.log(`${socket.owner? 'Owner' : 'Client'} disconnected for reason ${reason}`);
    });

    socket.on('data', async (requestBuffer, callback) => {
        let request;
        
        try {
            request = await Packet.fromBuffer(requestBuffer);
        } catch { return }

        if (!request.optional.host) {
            if (request.type == requestType.GET_FILE_METADATA) {
                owner?.emit('data', requestBuffer, buffer => callback(buffer));
                // TTL
            }

            if (request.type == requestType.GET_PARTITION) {
                owner?.emit('data', requestBuffer, buffer => callback(buffer));
            }
        } else {
            if (request.type == requestType.GET_FILE_METADATA || request.type == requestType.GET_PARTITION) {
                const socket = await getConnection(request.optional.host);
                if (!socket) {
                    return callback(new Uint8Array(0));
                }

                delete request.optional.host;
                socket.emit('data', await new Packet(
                    request.type,
                    request.hash,
                    request.optional
                ).pack(), buffer => callback(buffer));
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server started on http://127.0.0.1:${PORT}/`);
});