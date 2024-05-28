import getPrismaInstance from "../utils/PrismaClient.js";
import { renameSync } from "fs";
import CryptoJS from "crypto-js";
import { log } from "console";


const key = "awjnfaensljnvsv";

function decrypt(encryptedData, key){
      try {
        const bytes = CryptoJS.AES.decrypt(encryptedData, key)
        if(bytes.sigBytes > 0){
          const decryptedData = bytes.toString(CryptoJS.enc.Utf8)
          return decryptedData
        }
      } catch (error) {
        throw new Error("Cannot decrypt the data")
      }
    }

export const addMessage = async (req, res, next) => {
  try {
    const prisma = getPrismaInstance();
    const { message, from, to } = req.body;
    
    const getUser = onlineUsers.get(to);
    let translatedText=message
    let user = await prisma.user.findUnique({
        where: { id: from }
    });
    // const srcLang = user.lang;
    const userTo = await prisma.user.findUnique({
        where: { id: to }
    });
    const translateAndUpdate = async () => {
      const res = await fetch("http://localhost:5000/translate", {
      method: "POST",
      body: JSON.stringify({
        q: message,
        source: "auto",
        target: userTo.lang,
        format: "text",
        api_key: ""
      }),
      headers: { "Content-Type": "application/json" }
    });

      translatedText = (await res.json()).translatedText;
    }; 
    await translateAndUpdate();
  
    
    //encrypt here

    function encrypt(data, key){
      const cipherText = CryptoJS.AES.encrypt(data, key).toString();
      return cipherText;
    }    

    // pushin into DB
    if (message && from && to) {
      const newMessage = await prisma.messages.create({
        data: {
          messageS:encrypt(message, key),
          messageR:encrypt(translatedText, key),
          sender: { connect: { id: parseInt(from) } },
          receiver: { connect: { id: parseInt(to) } },
          messageStatus: getUser ? "delivered" : "sent",
        },
      });
      const decryptedMessage = {
      ...newMessage,
      messageS: decrypt(newMessage.messageS, key),
      messageR: decrypt(newMessage.messageR, key),
    };
    

    return res.status(201).send({ messageS: decryptedMessage, messageR:translatedText });
    }
    return res.status(400).send("From, to, and Message are required.");
  } catch (error) {
    next(error); 
  }
};


export const getMessages = async (req, res, next) => {
  try {
    const prisma = getPrismaInstance();
    const { from, to } = req.params;

    let messages = await prisma.messages.findMany({
      where: {
        OR: [
          {
            senderId: parseInt(from),
            receiverId: parseInt(to),
          },
          {
            senderId: parseInt(to),
            receiverId: parseInt(from),
          },
        ],
      },
      orderBy: {
        id: "asc",
      },
    });

    messages = messages.map(message => ({
    ...message,
    messageS: decrypt(message.messageS, key),
    messageR: decrypt(message.messageR, key),
  }
  ));
    const unreadMessages = [];

  
    messages.forEach((message, index) => {
      if (message.messageStatus !== "read" && message.senderId === parseInt(to)) {
        messages[index].messageStatus = "read";
        unreadMessages.push(message.id);
      }
    });

    await prisma.messages.updateMany({
      where: {
        id: { in: unreadMessages },
      },
      data: {
        messageStatus: "read",
      },
    });

    res.status(200).json({ messages });
  } catch (error) {
    next(error);
  }
};


export const addImageMessage = async (req, res, next) => {
  try {
    if (req.file) {
      const date = Date.now();
      let fileName = "uploads/images/" + date + req.file.originalname;
      renameSync(req.file.path, fileName);
      const prisma = getPrismaInstance();
      const { from, to } = req.query;

      if (from && to) {
        const message = await prisma.messages.create({
          data: {
            messageS: fileName,
            messageR: fileName,
            sender: { connect: { id: parseInt(from) } },
            receiver: { connect: { id: parseInt(to) } },
            type: "image",
          },
        });
        return res.status(201).json({ message });
      }
      return res.status(400).json("From, to is required.");
    }
    return res.status(400).send("Image is required.");
  } catch (error) {
    next(error);
  }
};


export const getInitialContactsWithMessages = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.from);
    const prisma = getPrismaInstance();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        sentMessages: {
          include: {
            receiver: true,
            sender: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        },
        receivedMessages: {
          include: {
            receiver: true,
            sender: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });
    const messages = [...user.sentMessages, ...user.receivedMessages];
    messages.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const users = new Map();
    const messageStatusChange = [];

    messages.forEach((msg) => {
      const isSender = msg.senderId === userId;
      const calculatedId = isSender ? msg.receiverId : msg.senderId;
      if (msg.messageStatus === "sent") {
        messageStatusChange.push(msg.id);
      }
      const {
        id,
        type,
        messageS,
        messageR,
        messageStatus,
        createdAt,
        senderId,
        receiverId,
      } = msg;
      if (!users.get(calculatedId)) {
        let user = {
          messageId: id,
          type,
          messageS,
          messageR,
          messageStatus,
          createdAt,
          senderId,
          receiverId,
        };
        if (isSender) {
          user = {
            ...user,
            ...msg.receiver,
            totalUnreadMessages: 0,
          };
        } else {
          user = {
            ...user,
            ...msg.sender,
            totalUnreadMessages: messageStatus !== "read" ? 1 : 0,
          };
        }
        users.set(calculatedId, { ...user });
      } else if (messageStatus !== "read" && !isSender) {
        const user = users.get(calculatedId);
        users.set(calculatedId, {
          ...user,
          totalUnreadMessages: user.totalUnreadMessages + 1,
        });
      }
    });
    if (messageStatusChange.length) {
      await prisma.messages.updateMany({
        where: {
          id: { in: messageStatusChange },
        },
        data: {
          messageStatus: "delivered",
        },
      });
    }
    return res.status(200).json({
      users: Array.from(users.values()),
      onlineUsers: Array.from(onlineUsers.keys()),
    });
  } catch (error) {
    next(error);
  }
};