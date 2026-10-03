# Feishu app permissions

Create an app in the Feishu/Lark tenant you control. Grant only the bot scopes
needed for the enabled features. The default private-assistant workflow needs
these four bot scopes and one employee scope for owner verification.

The user identity login is only for setup-time owner verification. Receiving
bot messages relies on the bot capability and long-connection event
subscription; it does not require user OAuth. Runtime messaging remains
bot-only.

| Type | Scope | Why it is requested |
| --- | --- | --- |
| Bot | `im:message.p2p_msg:readonly` | Receive one-to-one messages sent to the bot. |
| Bot | `im:message:send_as_bot` | Send replies as the bot. |
| Bot | `im:resource` | Read resources attached to received messages when a request uses them. |
| Bot | `cardkit:card:write` | Create or update progress cards. |
| Employee | `contact:user.employee:readonly` | During setup, verify that the app owner is the intended employee. It is not the runtime message-sending identity. |

## App setup

Interactive progress cards update the bot's own sent card through the message
update API. If your app reports a missing update permission, grant the
application-identity `im:message:update` scope and make it effective before
using progress updates. This is separate from permission to read chat history
or act as the user. A final-card send alone does not establish that progress
updates are available.

In the app configuration:

1. Enable the bot capability.
2. Subscribe to the `im.message.receive_v1` event through the long connection.
   This is an event subscription, not an API scope.
3. Publish an app version and make the bot visible to the intended owner.
4. Keep the app ID in the private project config and enter the app secret using
   `office setup <key>`. Never put the secret in a checked-in example or issue.
5. Follow [`setup.md`](setup.md) to verify the intended owner before starting
   the bot.

The setup flow checks identity using the enterprise email supplied by the
identity response when available. The `enterprise_email` value can be empty
even when the employee scope has been granted; do not assume that granting
more scopes will fill it.

If it is empty, union-ID verification requires a baseline established
independently of the candidate OAuth response: look up the exact intended
email in an authoritative directory, confirm that it resolves to one employee,
read back that employee's contact record, and use its nonempty union ID only
after confirming the tenant and that the app and directory records share the
same application developer/ISV union namespace. Set the expected union ID from
that baseline, then compare the candidate response with it. A matching tenant
alone does not establish the union-ID namespace, and the candidate response
must never establish its own expected identity.

## Features that need more permission

The default assistant does not need broad contact search or group message
history. Group history recording is off in the example config. If you enable a
history feature, review the scopes requested by the exact version you are
running and explain the additional collection to participants before enabling
it.

The default bot runtime does not request `offline_access`; do not grant it for
this release. A future feature that needs additional authorization must be
reviewed and documented separately.

App scopes and bot permissions are tenant-administered. Confirm the final
granted scopes in the Feishu/Lark developer console; a successful local
`doctor` result does not confirm tenant approval or message delivery.
