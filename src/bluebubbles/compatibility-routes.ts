/**
 * REST compatibility contract extracted from BlueBubbles server 1.9.9 at
 * f2e2286241a7c3b6617a82b37d4afaab4df3a6b9.
 *
 * The runtime recognizes every route in this table. Native implementations
 * are registered directly; unsupported administrative routes fall through to
 * the authenticated BlueBubbles-shaped 501 handler. Keeping the table in
 * production code also lets OpenAPI enumerate those compatibility routes
 * instead of documenting only the wildcard fallback.
 */
export const PINNED_BLUEBUBBLES_REST_ROUTES = `
GET /api/v1/ping
POST /api/v1/mac/lock
POST /api/v1/mac/imessage/restart
GET /api/v1/icloud/account
POST /api/v1/icloud/account/alias
GET /api/v1/icloud/contact
GET /api/v1/icloud/findmy/devices
POST /api/v1/icloud/findmy/devices/refresh
GET /api/v1/icloud/findmy/friends
POST /api/v1/icloud/findmy/friends/refresh
GET /api/v1/server/info
GET /api/v1/server/logs
GET /api/v1/server/restart/soft
GET /api/v1/server/restart/hard
GET /api/v1/server/update/check
POST /api/v1/server/update/install
GET /api/v1/server/alert
POST /api/v1/server/alert/read
GET /api/v1/server/statistics/totals
GET /api/v1/server/statistics/media
GET /api/v1/server/statistics/media/chat
POST /api/v1/fcm/device
GET /api/v1/fcm/client
GET /api/v1/attachment/count
POST /api/v1/attachment/upload
GET /api/v1/attachment/:guid/download
GET /api/v1/attachment/:guid/download/force
GET /api/v1/attachment/:guid/blurhash
GET /api/v1/attachment/:guid/live
GET /api/v1/attachment/:guid
POST /api/v1/chat/new
GET /api/v1/chat/count
POST /api/v1/chat/query
GET /api/v1/chat/:guid/message
GET /api/v1/chat/:guid/share/contact/status
POST /api/v1/chat/:guid/share/contact
POST /api/v1/chat/:guid/read
POST /api/v1/chat/:guid/unread
POST /api/v1/chat/:guid/leave
POST /api/v1/chat/:guid/participant
DELETE /api/v1/chat/:guid/participant
POST /api/v1/chat/:guid/participant/add
POST /api/v1/chat/:guid/participant/remove
POST /api/v1/chat/:guid/typing
DELETE /api/v1/chat/:guid/typing
POST /api/v1/chat/:guid/icon
DELETE /api/v1/chat/:guid/icon
GET /api/v1/chat/:guid/icon
DELETE /api/v1/chat/:guid/:messageGuid
PUT /api/v1/chat/:guid
GET /api/v1/chat/:guid
DELETE /api/v1/chat/:guid
POST /api/v1/message/text
POST /api/v1/message/attachment
POST /api/v1/message/multipart
POST /api/v1/message/react
GET /api/v1/message/count
GET /api/v1/message/count/updated
GET /api/v1/message/count/me
POST /api/v1/message/query
GET /api/v1/message/schedule
POST /api/v1/message/schedule
GET /api/v1/message/schedule/:id
PUT /api/v1/message/schedule/:id
DELETE /api/v1/message/schedule/:id
GET /api/v1/message/:guid
POST /api/v1/message/:guid/edit
POST /api/v1/message/:guid/unsend
POST /api/v1/message/:guid/notify
GET /api/v1/message/:guid/embedded-media
GET /api/v1/handle/count
POST /api/v1/handle/query
GET /api/v1/handle/availability/imessage
GET /api/v1/handle/availability/facetime
GET /api/v1/handle/:guid
GET /api/v1/handle/:guid/focus
POST /api/v1/facetime/session
POST /api/v1/facetime/answer/:call_uuid
POST /api/v1/facetime/leave/:call_uuid
GET /api/v1/contact
POST /api/v1/contact
POST /api/v1/contact/query
GET /api/v1/backup/theme
POST /api/v1/backup/theme
DELETE /api/v1/backup/theme
GET /api/v1/backup/settings
POST /api/v1/backup/settings
DELETE /api/v1/backup/settings
GET /api/v1/webhook
POST /api/v1/webhook
DELETE /api/v1/webhook/:id
`.trim().split("\n").map((entry) => {
  const separator = entry.indexOf(" ");
  return {
    method: entry.slice(0, separator),
    path: entry.slice(separator + 1),
  };
});
