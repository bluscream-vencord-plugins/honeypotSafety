//// Plugin originally written for Equicord at 2026-07-06 by https://github.com/Bluscream
// region Imports
import "./style.css";

import { sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Menu, PermissionsBits, PermissionStore, React, Toasts } from "@webpack/common";
import { Channel } from "@vencord/discord-types";

import { settings } from "./settings";
// endregion Imports

import { pluginInfo } from "./info";
export { pluginInfo };

// region Variables
const logger = new Logger(pluginInfo.id, pluginInfo.color);

// GUILD_TEXT - the only channel type the honeypot menu is offered on
const GUILD_TEXT_CHANNEL_TYPE = 0;
// endregion Variables

// region Utils
function getHoneypotSet(): Set<string> {
    return new Set(
        (settings.store.honeypotChannels ?? "")
            .split(",")
            .map(id => id.trim())
            .filter(Boolean)
    );
}

function saveHoneypotSet(set: Set<string>) {
    settings.store.honeypotChannels = [...set].join(",");
}

function isHoneypot(channelId?: string | null): boolean {
    if (!channelId) return false;
    return getHoneypotSet().has(channelId);
}

function toggleHoneypot(channel: Channel) {
    const set = getHoneypotSet();
    const nowHoneypot = !set.has(channel.id);

    if (nowHoneypot) set.add(channel.id);
    else set.delete(channel.id);

    saveHoneypotSet(set);

    // Notify subscribers (the chat input subscribes to PermissionStore) so the
    // message box re-evaluates its permissions and greys out immediately.
    try {
        PermissionStore.emitChange();
    } catch (e) {
        logger.warn("Failed to emit PermissionStore change", e);
    }

    logger.info(`${nowHoneypot ? "Marked" : "Unmarked"} channel ${channel.id} as honeypot`);

    if (settings.store.showToast) {
        Toasts.show({
            type: nowHoneypot ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS,
            message: nowHoneypot
                ? "🍯 Channel marked as honeypot - writing disabled"
                : "Channel unmarked - writing enabled",
            id: Toasts.genId()
        });
    }
}
// "Eat" mode: let the user type and hit send, but swallow the message before it
// reaches Discord's API and reply with a local ephemeral Clyde notice - mimicking
// how Discord rejects a message you weren't allowed to send.
const eatMessageListener: MessageSendListener = (channelId, messageObj) => {
    if (settings.store.mode !== "eat" || !isHoneypot(channelId)) return;

    // Ignore empty sends (e.g. attachment-only handled elsewhere / stray events).
    if (!messageObj.content?.trim()) return { cancel: true };

    sendBotMessage(channelId, { content: settings.store.eatMessage });
    logger.info(`Swallowed a message in honeypot channel ${channelId}`);
    return { cancel: true };
};
// endregion Utils

// region Context Menu
const patchChannelContextMenu: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!channel || channel.type !== GUILD_TEXT_CHANNEL_TYPE) return;

    const honeypot = isHoneypot(channel.id);

    children.push(
        <Menu.MenuItem
            id="honeypot-safety-toggle"
            label={honeypot ? "🍯 Unmark as Honeypot" : "🍯 Mark as Honeypot"}
            color={honeypot ? undefined : "danger"}
            action={() => toggleHoneypot(channel)}
        />
    );
};
// endregion Context Menu

// region Definition
export default definePlugin({
    name: pluginInfo.name,
    description: pluginInfo.description,
    authors: pluginInfo.authors,
    settings,
    dependencies: ["MessageEventsAPI"],

    contextMenus: {
        "channel-context": patchChannelContextMenu,
    },

    patches: [
        // === MODE "banner" ===
        // Discord's chat container renders `renderMessageBanner(...) ?? <form>…</form>`,
        // swapping the input for a banner in states like timeout/quarantine. We hook
        // that seam so our read-only notice replaces the composer for honeypot channels.
        // (Verified via CDP that this build does NOT disable the composer on missing
        // SEND_MESSAGES, so patching permissions alone can't reach this render path.)
        {
            find: "inputFormRef",
            predicate: () => settings.store.mode === "banner",
            replacement: {
                match: /this\.renderMessageBanner\((\{channel:(\i)[^{}]*\})\)\?\?/,
                replace: "$self.renderHoneypotBanner($2)??this.renderMessageBanner($1)??"
            }
        },
        // === MODE "permissions" ===
        // Emulate a real permission removal by stripping SEND_MESSAGES from every
        // permission computation for honeypot channels: `can`, `getChannelPermissions`
        // and `computePermissions`. When all three agree (as they do for a genuinely
        // restricted channel) Discord renders its own native no-send composer.
        // Verified live via CDP that overriding all three - and only all three - works.
        {
            find: "canBasicChannel(",
            predicate: () => settings.store.mode === "permissions",
            replacement: [
                {
                    // `can(permission, channelOrGuild, ...rest){` - anchored to the
                    // method definition, not `.can(` call sites.
                    match: /(?<![.\w])can\((\i),(\i)((?:,\i)*)\)\{/,
                    replace: "can($1,$2$3){if($self.shouldBlockSend($1,$2))return false;"
                },
                {
                    // getChannelPermissions(e){return <expr>} → mask the returned bigint
                    match: /(getChannelPermissions\((\i)\)\{return )(.+?)(\})/,
                    replace: "$1$self.maskPerms($2,$3)$4"
                },
                {
                    // computePermissions(e,...){return <expr>} → mask the returned bigint
                    match: /(computePermissions\((\i)(?:,\i)*\)\{return )(.+?)(\})/,
                    replace: "$1$self.maskPerms($2,$3)$4"
                }
            ]
        },
        // --- Channel-list badge (optional, gated by the showBadge setting) ---
        // Normal channels
        {
            find: "UNREAD_IMPORTANT:",
            predicate: () => settings.store.showBadge,
            replacement: {
                match: /\.Children\.count.+?:null(?<=,channel:(\i).+?)/,
                replace: "$&,$self.renderHoneypotBadge($1)"
            }
        },
        // Threads
        {
            find: "18V16H9v2H6Zm3",
            predicate: () => settings.store.showBadge,
            replacement: {
                match: /mentionsCount:\i.+?null(?<=channel:(\i).+?)/,
                replace: "$&,$self.renderHoneypotBadge($1)"
            }
        }
    ],

    start() {
        // "Eat" mode is driven at runtime (no patch), so register the send listener
        // unconditionally - it no-ops unless the mode is "eat" and the channel is a
        // honeypot. This lets switching to/from "eat" work without a full restart.
        addMessagePreSendListener(eatMessageListener);

        // Dev-mode assertion: in "permissions" mode the patches inject $self calls
        // into PermissionStore.{can,getChannelPermissions,computePermissions}, so
        // those identifiers must appear in the functions' sources. If any is missing,
        // the regex failed to match (likely a Discord update changed the minified
        // shape) and honeypots silently do nothing - surface that loudly.
        if (IS_DEV && settings.store.mode === "permissions") {
            const checks: [string, boolean][] = [
                ["can", PermissionStore.can.toString().includes("shouldBlockSend")],
                ["getChannelPermissions", PermissionStore.getChannelPermissions.toString().includes("maskPerms")],
                ["computePermissions", PermissionStore.computePermissions.toString().includes("maskPerms")],
            ];
            const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
            if (failed.length) {
                logger.error(
                    `PermissionStore patches did NOT apply for: ${failed.join(", ")}. ` +
                    "Honeypot permission-spoofing is inactive/partial - the match/find in patches[] " +
                    "needs updating for the current Discord build."
                );
            } else {
                logger.info("PermissionStore permission-spoof patches verified - honeypot send-blocking active.");
            }
        }
    },

    stop() {
        removeMessagePreSendListener(eatMessageListener);
    },

    // Called from the patched getChannelPermissions/computePermissions. Strips the
    // SEND_MESSAGES bit from a channel's computed permissions for honeypot channels.
    maskPerms(channelOrGuild: any, perms: bigint): bigint {
        try {
            if (channelOrGuild && isHoneypot(channelOrGuild.id)) {
                return BigInt(perms) & ~PermissionsBits.SEND_MESSAGES;
            }
        } catch (e) {
            logger.error("Error in maskPerms", e);
        }
        return perms;
    },

    // Replaces the message composer with a read-only notice in honeypot channels.
    // Returns null for normal channels so Discord's own `?? renderMessageBanner ?? form`
    // chain proceeds unchanged.
    renderHoneypotBanner(channel: any) {
        try {
            if (!channel || !isHoneypot(channel.id)) return null;
            return (
                <div className="honeypot-readonly-bar" role="alert">
                    🍯 You do not have permission to send messages in this channel.
                </div>
            );
        } catch (e) {
            logger.error("Error in renderHoneypotBanner", e);
            return null;
        }
    },

    // Called from the patched PermissionStore.can. Returns true when the check
    // is a SEND_MESSAGES request against a honeypot channel, which we deny.
    shouldBlockSend(permission: bigint, channelOrGuild: any): boolean {
        try {
            return !!channelOrGuild
                && isHoneypot(channelOrGuild.id)
                && (permission & PermissionsBits.SEND_MESSAGES) === PermissionsBits.SEND_MESSAGES;
        } catch (e) {
            logger.error("Error in shouldBlockSend", e);
            return false;
        }
    },

    renderHoneypotBadge(channel: any) {
        if (!channel || !settings.store.showBadge || !isHoneypot(channel.id)) return null;

        return (
            <div className="honeypot-badge-container">
                <div className="honeypot-badge" title="This channel is marked as a honeypot - sending messages is disabled.">
                    🍯
                </div>
            </div>
        );
    }
});
// endregion Definition
