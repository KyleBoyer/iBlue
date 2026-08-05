import type { Conversation, IncomingMessage } from "../types.js";

export function stripTransport(address: string): string {
  return address.replace(/^(mailto:|tel:)/i, "");
}

export function toTransportAddress(address: string): string {
  if (/^(mailto:|tel:)/i.test(address)) return address;
  return address.includes("@") ? `mailto:${address}` : `tel:${address}`;
}

export function directChatGuid(address: string, isSms = false): string {
  return `${isSms ? "SMS" : "iMessage"};-;${stripTransport(address)}`;
}

export function groupChatGuid(groupId: string, isSms = false): string {
  return `${isSms ? "SMS" : "iMessage"};+;${groupId}`;
}

export function conversationFromDirectChatGuid(chatGuid: string): Conversation | undefined {
  const match = /^(iMessage|SMS);-;(.+)$/.exec(chatGuid);
  if (!match?.[2]) return undefined;
  return {
    participants: [toTransportAddress(match[2])],
    isSms: match[1] === "SMS",
  };
}

export function incomingParticipants(
  message: IncomingMessage,
  ownHandles: readonly string[],
): string[] {
  const own = new Set(ownHandles.map(addressKey));
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const address of [message.sender, ...message.participants]) {
    if (!address) continue;
    const key = addressKey(address);
    if (own.has(key) || seen.has(key)) continue;
    seen.add(key);
    participants.push(toTransportAddress(address));
  }
  return participants;
}

export function isIncomingGroup(message: IncomingMessage, ownHandles: readonly string[]): boolean {
  if (!message.senderGuid) return false;
  // rustpush can attach a conversation UUID to a one-to-one message. A UUID
  // alone therefore does not prove group membership. A named conversation or
  // more than one non-self participant does.
  return Boolean(message.groupName) || incomingParticipants(message, ownHandles).length > 1;
}

export function deriveIncomingChatGuid(message: IncomingMessage, ownHandles: readonly string[]): string {
  if (isIncomingGroup(message, ownHandles)) return groupChatGuid(message.senderGuid!, message.isSms);
  const candidates = incomingParticipants(message, ownHandles);
  const address = candidates[0] ?? message.sender ?? message.participants[0] ?? "unknown";
  return directChatGuid(address, message.isSms);
}

function addressKey(address: string): string {
  return stripTransport(address).toLowerCase();
}

export function chatIdentifier(chatGuid: string): string {
  return chatGuid.split(";").slice(2).join(";");
}
