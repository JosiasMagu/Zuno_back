type ConversationEntity = {
  id: string;
  clientId: string;
  ownerId: string;
  equipmentId: string | null;
  serviceId?: string | null;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  client: { id: string; name: string; avatarUrl: string | null };
  owner: { id: string; name: string; avatarUrl: string | null };
  equipment: { id: string; title: string; photos: { url: string }[] } | null;
  service?: { id: string; title: string; photos: { url: string }[] } | null;
  _count?: { messages: number };
};

type MessageEntity = {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  isRead: boolean;
  createdAt: Date;
  sender: { id: string; name: string; avatarUrl: string | null };
};

export class ChatPresenter {
  static toConversation(conv: ConversationEntity, currentUserId: string) {
    const other = conv.clientId === currentUserId ? conv.owner : conv.client;
    const subject = conv.equipment ?? conv.service ?? null;

    return {
      id: conv.id,
      equipmentId: conv.equipmentId,
      serviceId: conv.serviceId ?? null,
      equipmentTitle: subject?.title ?? null,
      equipmentImage: subject?.photos?.[0]?.url ?? null,
      other: {
        id: other.id,
        name: other.name,
        avatarUrl: other.avatarUrl,
      },
      lastMessage: conv.lastMessage ?? null,
      lastMessageAt: conv.lastMessageAt ?? null,
      createdAt: conv.createdAt,
    };
  }

  static toMessage(msg: MessageEntity) {
    return {
      id: msg.id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      senderName: msg.sender.name,
      senderAvatar: msg.sender.avatarUrl,
      content: msg.content,
      isRead: msg.isRead,
      createdAt: msg.createdAt,
    };
  }
}
