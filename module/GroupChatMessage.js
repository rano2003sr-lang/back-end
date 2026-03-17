const mongoose = require("mongoose");

const GroupChatMessageSchema = new mongoose.Schema(
  {
    fromId: { type: String, required: true },
    fromName: { type: String, default: "" },
    fromProfileImage: { type: String, default: null },
    fromAge: { type: Number, default: null },
    fromGender: { type: String, default: null },
    fromDiamonds: { type: Number, default: null },
    fromChargedGold: { type: Number, default: null },
    toId: { type: String, default: null },
    text: { type: String, default: "" },
    replyToText: { type: String, default: null },
    replyToFromId: { type: String, default: null },
    replyToFromName: { type: String, default: null },
    audioUrl: { type: String, default: null },
    audioDurationSeconds: { type: Number, default: null },
    imageUrl: { type: String, default: null },
  },
  { timestamps: true }
);

GroupChatMessageSchema.index({ createdAt: 1 });

module.exports = mongoose.model("GroupChatMessage", GroupChatMessageSchema);
