import type { Chat, ChatMember, ChatType, MemberRole } from '@prisma/client';

export type ChatWithMembers = Chat & { members: ChatMember[] };

export interface ChatMemberDto {
  userId: string;
  role: MemberRole;
  joinedAt: string;
}

export interface ChatSummary {
  chatId: string;
  type: ChatType;
  name: string | null;
  memberIds: string[];
  createdAt: string;
}

export interface ChatDetails extends ChatSummary {
  createdBy: string | null;
  members: ChatMemberDto[];
}

export function toChatSummary(chat: ChatWithMembers): ChatSummary {
  return {
    chatId: chat.id,
    type: chat.type,
    name: chat.name,
    memberIds: chat.members.map((m) => m.userId),
    createdAt: chat.createdAt.toISOString(),
  };
}

export function toChatDetails(chat: ChatWithMembers): ChatDetails {
  return {
    ...toChatSummary(chat),
    createdBy: chat.createdBy,
    members: chat.members.map((m) => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    })),
  };
}
