import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    honeypotChannels: {
        type: OptionType.STRING,
        description: "Comma-separated list of channel IDs marked as honeypots (managed via the channel right-click menu, but editable here too)",
        default: "",
        restartNeeded: false,
    },
    mode: {
        type: OptionType.SELECT,
        description: "How to disable sending in honeypot channels",
        restartNeeded: true,
        options: [
            {
                label: "Banner - replace the input with a read-only notice",
                value: "banner",
                default: true,
            },
            {
                label: "Permissions - emulate a real permission removal (native Discord no-send composer)",
                value: "permissions",
            },
            {
                label: "Eat - allow typing, but silently swallow sends and reply with an ephemeral Clyde notice",
                value: "eat",
            },
        ],
    },
    eatMessage: {
        type: OptionType.STRING,
        description: "The ephemeral Clyde message shown when a send is swallowed in \"Eat\" mode",
        default: "Your message could not be delivered because you do not have permission to send messages in this channel.",
        restartNeeded: false,
    },
    showToast: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when marking/unmarking a channel as a honeypot",
        default: true,
        restartNeeded: false,
    },
    showBadge: {
        type: OptionType.BOOLEAN,
        description: "Show a 🍯 badge next to honeypot channels in the channel list",
        default: true,
        restartNeeded: true,
    }
});
