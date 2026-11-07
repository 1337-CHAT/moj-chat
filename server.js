const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_FILE = path.join(__dirname, 'databaza.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initData = { users: [], friends: [], requests: [], messages: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initData, null, 2));
    return initData;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE));
  } catch(e) {
    return { users: [], friends: [], requests: [], messages: [] };
  }
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch(e) {}
}

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const f1 = path.join(__dirname, 'index.html');
  const f2 = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(f1)) return res.sendFile(f1);
  if (fs.existsSync(f2)) return res.sendFile(f2);
  res.send("Hľadá sa index.html...");
});

io.on('connection', (socket) => {
  let currentUser = null;

  // 1. REGISTRÁCIA (Rovno prihlási používateľa)
  socket.on('register', ({ username, password }) => {
    const db = loadDB();
    const cleanUser = (username || '').trim();
    if (!cleanUser || !password) {
      return socket.emit('auth_error', 'Vyplňte meno aj heslo!');
    }

    const existing = db.users.find(u => u.username.toLowerCase() === cleanUser.toLowerCase());
    if (existing) {
      // Ak používateľ existuje a heslo sedí, rovno ho prihlásime
      if (existing.password === password) {
        currentUser = existing.username;
        socket.join(currentUser);
        socket.emit('login_success', { username: currentUser });
        return sendUserData(socket, currentUser);
      } else {
        return socket.emit('auth_error', 'Meno ' + cleanUser + ' už existuje, zadajte správne heslo!');
      }
    }

    // Nový účet
    db.users.push({ username: cleanUser, password: password });
    saveDB(db);
    currentUser = cleanUser;
    socket.join(currentUser);
    socket.emit('login_success', { username: currentUser });
    sendUserData(socket, currentUser);
  });

  // 2. PRIHLÁSENIE (Ak server zaspal a zabudol účet, automaticky ho obnoví)
  socket.on('login', ({ username, password }) => {
    const db = loadDB();
    const cleanUser = (username || '').trim();
    if (!cleanUser || !password) return socket.emit('auth_error', 'Vyplňte údaje!');

    const existing = db.users.find(u => u.username.toLowerCase() === cleanUser.toLowerCase());

    if (!existing) {
      // Server sa po reštarte Renderu obnovil -> automaticky obnovíme účet
      db.users.push({ username: cleanUser, password: password });
      saveDB(db);
      currentUser = cleanUser;
      socket.join(currentUser);
      socket.emit('login_success', { username: currentUser });
      return sendUserData(socket, currentUser);
    }

    if (existing.password !== password) {
      return socket.emit('auth_error', 'Nesprávne heslo pre ' + cleanUser + '!');
    }

    currentUser = existing.username;
    socket.join(currentUser);
    socket.emit('login_success', { username: currentUser });
    sendUserData(socket, currentUser);
  });

  // 3. ŽIADOSTI
  socket.on('send_request', (targetUser) => {
    if (!currentUser) return;
    const db = loadDB();
    const target = (targetUser || '').trim();

    if (target.toLowerCase() === currentUser.toLowerCase()) {
      return socket.emit('alert', 'Nemôžete poslať žiadosť samému sebe!');
    }
    const exists = db.users.find(u => u.username.toLowerCase() === target.toLowerCase());
    if (!exists) {
      return socket.emit('alert', 'Používateľ ' + target + ' neexistuje!');
    }

    const actualTargetName = exists.username;
    const isFriend = db.friends.some(f => 
      (f.u1 === currentUser && f.u2 === actualTargetName) || 
      (f.u2 === currentUser && f.u1 === actualTargetName)
    );
    if (isFriend) return socket.emit('alert', 'Používateľ je už váš priateľ!');

    const reqExists = db.requests.some(r => 
      (r.from === currentUser && r.to === actualTargetName) ||
      (r.from === actualTargetName && r.to === currentUser)
    );
    if (reqExists) return socket.emit('alert', 'Žiadosť už čaká na vybavenie!');

    db.requests.push({ from: currentUser, to: actualTargetName });
    saveDB(db);

    socket.emit('alert', 'Žiadosť odoslaná pre ' + actualTargetName);
    sendUserData(socket, currentUser);
    io.to(actualTargetName).emit('update_data');
  });

  socket.on('accept_request', (fromUser) => {
    if (!currentUser) return;
    const db = loadDB();
    db.requests = db.requests.filter(r => !(r.from === fromUser && r.to === currentUser));
    db.friends.push({ u1: currentUser, u2: fromUser });
    saveDB(db);
    sendUserData(socket, currentUser);
    io.to(fromUser).emit('update_data');
  });

  socket.on('reject_request', (fromUser) => {
    if (!currentUser) return;
    const db = loadDB();
    db.requests = db.requests.filter(r => !(r.from === fromUser && r.to === currentUser));
    saveDB(db);
    sendUserData(socket, currentUser);
  });

  // 4. SPRÁVY
  socket.on('send_private_message', ({ to, text }) => {
    if (!currentUser || !text.trim()) return;
    const db = loadDB();
    const msg = { from: currentUser, to: to, text: text.trim(), time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    db.messages.push(msg);
    saveDB(db);

    socket.emit('new_message', msg);
    io.to(to).emit('new_message', msg);
  });

  socket.on('load_messages', (withUser) => {
    if (!currentUser) return;
    const db = loadDB();
    const chatMsgs = db.messages.filter(m => 
      (m.from === currentUser && m.to === withUser) || 
      (m.from === withUser && m.to === currentUser)
    );
    socket.emit('chat_history', { withUser: withUser, messages: chatMsgs });
  });

  socket.on('request_update', () => {
    if (currentUser) sendUserData(socket, currentUser);
  });
});

function sendUserData(socket, username) {
  const db = loadDB();
  const myFriends = db.friends
    .filter(f => f.u1 === username || f.u2 === username)
    .map(f => f.u1 === username ? f.u2 : f.u1);

  const incomingRequests = db.requests.filter(r => r.to === username).map(r => r.from);
  socket.emit('user_data', { friends: myFriends, requests: incomingRequests });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("1337 Server bezi na porte: " + PORT);
});
