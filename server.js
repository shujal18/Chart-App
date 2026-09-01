const http = require("http");
const fs = require("fs");
const WebSocket = require("ws");

const server = http.createServer((req, res) => {
    fs.readFile("./index.html", (err, content) => {
        if (err) { res.writeHead(500); return res.end("Error"); }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
    });
});

const wss = new WebSocket.Server({ server, maxPayload: 5 * 1024 * 1024 });

const rooms = {};
let latestPublicCode = "";
const MAX_PER_ROOM = 6;
const SECRET_ROOM_MAX = 2;
const MAX_HISTORY = 200;
const MSG_TTL = 3 * 60 * 1000;
const INACTIVE_TIMEOUT = 5 * 60 * 1000;
const SECRET_ROOM_MEMBERS = ["tom", "jerry"];

function heartbeat() { this.isAlive = true; }

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const code in rooms) {
        if (rooms[code].users.size === 0 && now - rooms[code].lastActivity > INACTIVE_TIMEOUT) {
            delete rooms[code];
            console.log(`Cleaned up inactive room: ${code}`);
        }
        if (rooms[code] && rooms[code].messages.length > 0) {
            const oldLen = rooms[code].messages.length;
            rooms[code].messages = rooms[code].messages.filter(m => now - (m.timestamp || 0) < MSG_TTL);
            if (rooms[code].messages.length < oldLen) {
                rooms[code].users.forEach(c => {
                    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "cleanup" }));
                });
            }
        }
    }
}, 30000);

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", heartbeat);

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);

            if (data.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
            if (data.type === "generate_code") { latestPublicCode = data.code; }

            if (data.type === "join") {
                const val = data.room.toUpperCase();
                const isSecret = (val === "SUSHU" || val === "SK_ROOM");
                let targetRoom = null;
                if (isSecret) {
                    const uname = (data.username || "").trim().toLowerCase();
                    if (SECRET_ROOM_MEMBERS.includes(uname)) {
                        targetRoom = "SK_ROOM";
                    } else {
                        ws.send(JSON.stringify({ type: "error", message: "Can't join" }));
                        return;
                    }
                }
                else if (val === latestPublicCode || rooms[val]) targetRoom = val;

                if (targetRoom) {
                    if (!rooms[targetRoom]) rooms[targetRoom] = { users: new Set(), messages: [], lastActivity: Date.now() };
                    const maxUsers = targetRoom === "SK_ROOM" ? SECRET_ROOM_MAX : MAX_PER_ROOM;
                    const unameKey = (data.username || "").trim().toLowerCase();
                    const silentJoin = !!data.silent || !!data.background;
                    const activeNames = new Set(
                        [...rooms[targetRoom].users]
                            .filter(u => !u.silent)
                            .map(u => (u.username || "").trim().toLowerCase())
                    );
                    const nameTaken = activeNames.has(unameKey);
                    const roomFull = activeNames.size >= maxUsers;
                    if (!silentJoin && (roomFull || nameTaken)) {
                        const msg = nameTaken ? "Name already taken in this room!" : (targetRoom === "SK_ROOM" ? "Secret room is full! Only 2 users allowed." : "Room is full!");
                        ws.send(JSON.stringify({ type: "error", message: msg }));
                        return;
                    }
                    ws.room = targetRoom;
                    ws.username = data.username;
                    ws.avatar = data.avatar;
                    ws.silent = silentJoin;
                    rooms[ws.room].users.add(ws);
                    rooms[ws.room].lastActivity = Date.now();

                    ws.send(JSON.stringify({ type: "join_success", room: ws.room }));
                    if (!ws.silent) {
                        const now = Date.now();
                        rooms[ws.room].messages.filter(m => now - (m.timestamp || 0) < MSG_TTL)
                            .forEach(m => ws.send(JSON.stringify({ type: "message", message: m })));

                        const isRejoin = [...rooms[ws.room].users].some(u =>
                            u !== ws && !u.silent &&
                            (u.username || "").trim().toLowerCase() === (ws.username || "").trim().toLowerCase());
                        if (!isRejoin) broadcast(ws.room, { type: "system", text: `${ws.avatar} ${ws.username} joined!` });
                        broadcastOnline(ws.room);
                    }
                } else {
                    ws.send(JSON.stringify({ type: "error", message: "Invalid room code!" }));
                }
            }

            if (data.type === "message" && ws.room) {
                const ts = data.timestamp || Date.now();
                const msgPayload = {
                    id: data.id || "msg-" + Date.now(),
                    sender: ws.username,
                    avatar: ws.avatar,
                    text: data.text,
                    timestamp: ts,
                    fullTime: data.fullTime,
                    replyTo: data.replyTo,
                    photo: data.photo || null,
                    audio: data.audio || null,
                    dur: data.dur || null,
                    reactions: {},
                    seenBy: [],
                    edited: false
                };
                rooms[ws.room].messages.push(msgPayload);
                rooms[ws.room].lastActivity = Date.now();
                if (rooms[ws.room].messages.length > MAX_HISTORY) rooms[ws.room].messages.shift();
                broadcast(ws.room, { type: "message", message: msgPayload });
            }

            if (data.type === "nudge" && ws.room === "SK_ROOM") {
                rooms[ws.room].lastActivity = Date.now();
                const out = JSON.stringify({ type: "nudge", from: ws.username, avatar: ws.avatar });
                rooms[ws.room].users.forEach(c => {
                    if (c !== ws && c.readyState === WebSocket.OPEN) c.send(out);
                });
            }

            if (data.type === "clear_messages" && ws.room === "SK_ROOM") {
                rooms[ws.room].messages = [];
                rooms[ws.room].lastActivity = Date.now();
                broadcast(ws.room, { type: "messages_cleared" });
            }

            if (data.type === "reaction" && ws.room) {
                const msgObj = rooms[ws.room].messages.find(m => m.id === data.id);
                if (msgObj) {
                    if (!msgObj.reactions) msgObj.reactions = {};
                    if (!msgObj.reactions[data.emoji]) msgObj.reactions[data.emoji] = [];
                    const users = msgObj.reactions[data.emoji];
                    const idx = users.indexOf(ws.username);
                    if (idx >= 0) users.splice(idx, 1); else users.push(ws.username);
                    if (users.length === 0) delete msgObj.reactions[data.emoji];
                    rooms[ws.room].lastActivity = Date.now();
                    broadcast(ws.room, { type: "reaction_update", id: data.id, reactions: msgObj.reactions });
                }
            }

            if (data.type === "seen" && ws.room) {
                const ids = data.ids || [];
                let changed = false;
                ids.forEach(id => {
                    const msgObj = rooms[ws.room].messages.find(m => m.id === id);
                    if (msgObj && msgObj.sender !== ws.username) {
                        if (!msgObj.seenBy) msgObj.seenBy = [];
                        if (!msgObj.seenBy.includes(ws.username)) { msgObj.seenBy.push(ws.username); changed = true; }
                    }
                });
                if (changed) broadcast(ws.room, { type: "seen_update", ids, by: ws.username });
            }

            if (data.type === "edit_message" && ws.room) {
                const msgObj = rooms[ws.room].messages.find(m => m.id === data.id);
                if (msgObj && msgObj.sender === ws.username) {
                    msgObj.text = data.newText;
                    msgObj.edited = true;
                    rooms[ws.room].lastActivity = Date.now();
                    broadcast(ws.room, { type: "edit_update", id: data.id, newText: data.newText });
                }
            }

            if (data.type === "delete_message" && ws.room) {
                rooms[ws.room].messages = rooms[ws.room].messages.filter(m => !(m.id === data.id && m.sender === ws.username));
                rooms[ws.room].lastActivity = Date.now();
                broadcast(ws.room, { type: "delete_update", id: data.id });
            }

            if (data.type === "leave_room" && ws.room) {
                const room = ws.room;
                const leavingName = (ws.username || "").trim().toLowerCase();
                for (const u of [...rooms[room].users]) {
                    if ((u.username || "").trim().toLowerCase() === leavingName) {
                        u.room = null;
                        rooms[room].users.delete(u);
                    }
                }
                broadcast(room, { type: "system", text: `${ws.username} left.` });
                if (rooms[room].users.size === 0) delete rooms[room];
                else broadcastOnline(room);
                ws.send(JSON.stringify({ type: "left_room" }));
            }

            if (["typing"].includes(data.type) && ws.room) {
                rooms[ws.room].lastActivity = Date.now();
                broadcast(ws.room, { ...data, sender: ws.username, avatar: ws.avatar });
            }
        } catch (e) {
            console.error("Error:", e);
        }
    });

    ws.on("close", () => {
        if (ws.room && rooms[ws.room]) {
            const room = ws.room;
            rooms[room].users.delete(ws);
            const stillThere = [...rooms[room].users].some(u =>
                (u.username || "").trim().toLowerCase() === (ws.username || "").trim().toLowerCase());
            if (!stillThere && !ws.silent) {
                broadcast(room, { type: "system", text: `${ws.username} left.` });
            }
            if (!stillThere) broadcastOnline(room);
            if (rooms[room].users.size === 0) delete rooms[room];
        }
    });
});

wss.on("close", () => { clearInterval(heartbeatInterval); clearInterval(cleanupInterval); });

function broadcast(room, data) {
    if (!rooms[room]) return;
    const out = JSON.stringify(data);
    rooms[room].users.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(out); });
}

function broadcastOnline(room) {
    if (!rooms[room]) return;
    const seen = new Set();
    const users = [];
    for (const u of rooms[room].users) {
        const key = (u.username || "").trim().toLowerCase();
        if (!seen.has(key)) { seen.add(key); users.push({ name: u.username, avatar: u.avatar }); }
    }
    const count = Math.max(users.length, 1);
    rooms[room].users.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "online_count", count, users }));
    });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => console.log(`Server running on ${PORT} (in-memory, ${MSG_TTL/60000} min TTL)`));
