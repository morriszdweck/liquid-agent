//! Core behavior for the Rust migration of Liquid Agent.

/// Shell command fragments which always require a user's approval.
/// Keep these in sync with the existing server until it is migrated.
const HARD_DENY: &[&str] = &[
    "rm -rf /",
    "rm -rf ~",
    "rm -rf *",
    "sudo ",
    "mkfs",
    "dd if=",
    ":(){",
    "chmod -r 777",
    "curl | sh",
    "| sh",
    "| bash",
    "| zsh",
    "diskutil erase",
    "launchctl",
    "security ",
    "csrutil",
    "defaults delete",
    "osascript",
    "> /dev/",
    "shutdown",
    "reboot",
    "pkexec",
    "doas ",
    "su -",
    "su root",
    "systemctl stop",
    "systemctl disable",
    "systemctl mask",
    "systemctl isolate",
    "wipefs",
    "fdisk",
    "parted ",
    "mkswap",
    "poweroff",
    "crontab -r",
    "chattr ",
];

/// Whether a tool invocation must be approved by a person.
pub fn hard_deny(tool: &str, command: &str) -> bool {
    if tool != "shell" {
        return false;
    }
    let mut normalized = String::with_capacity(command.len());
    let mut whitespace = false;
    for c in command.chars() {
        if c.is_whitespace() {
            if !whitespace {
                normalized.push(' ');
            }
            whitespace = true;
        } else {
            normalized.extend(c.to_lowercase());
            whitespace = false;
        }
    }
    HARD_DENY.iter().any(|pattern| normalized.contains(pattern))
}

#[cfg(test)]
mod tests {
    use super::hard_deny;

    #[test]
    fn dangerous_shell_commands_require_approval() {
        for command in [
            "sudo apt update",
            "SYSTEMCTL   STOP sshd",
            "echo x | bash",
            "rm -rf /",
            "sudo ",
            "chmod -R 777 /tmp/example",
        ] {
            assert!(hard_deny("shell", command), "{command}");
        }
    }

    #[test]
    fn ordinary_commands_and_other_tools_do_not_match() {
        assert!(!hard_deny("shell", "ls -la"));
        assert!(!hard_deny("read_file", "sudo apt update"));
    }
}

pub mod gguf;
pub mod i18n;
pub mod memory;
pub mod models;
pub mod routines;
pub mod settings;
pub mod toolparser;
