// What each admin activity log entry means, in words.
export const AUDIT_ACTIONS: Record<string, string> = {
  add_key: "Added a key",
  edit_key: "Edited a key",
  replace_key: "Replaced a key",
  delete_key: "Deleted a key",
  add_user: "Added a person",
  edit_user: "Changed a person",
  view_conversation: "Opened a chat",
  view_declined: "Looked at declined messages",
  delete_conversation: "Deleted a chat",
  edit_settings: "Changed settings",
};
