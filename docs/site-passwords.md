# Passwords that an agent makes for a site

**Short answer**

Sometimes an agent must make a new account on a site, for example a careers portal. The user can
allow the agent to make that password itself. The agent makes a random password, stores it in the
macOS Keychain, and types it from there. The password never shows in chat, logs, files,
arguments or the environment.

**Where it fits**

`AGENTS.md` (Secrets) says where secrets live and that an agent never prints one. This file adds
one case: a secret that the agent makes itself. The typing step uses Eyes & Hands (the `eyes-hands`
skill).

```
 random bytes ──► password ──► security -i (stdin) ──► Keychain item <project>:site:<id>
                                                          │
                     security find-generic-password -w ◄──┘
                                   │ stdout, piped
                                   ▼
               JSON {"text":…} on stdin ──► eyeshands hands type … -  ──► focused field
```

**Step by step**

1. Get the user's approval for this kind of account first. Note it in the profile.
2. Choose the Keychain service name, for example `myproject:site:examplejobs`.
3. Check that no item with that name exists. Never overwrite an existing item.
4. Make the password from the system random source and store it through `security -i` on stdin.
5. Type the password from the Keychain through a pipe into the typing tool.
6. Write the service name, never the value, in the profile's `secrets.md`.

Steps 3 and 4 in zsh (`print` is a shell builtin, so the password is in no process's arguments):

```zsh
svc="myproject:site:examplejobs"
if security find-generic-password -a "$USER" -s "$svc" >/dev/null 2>&1; then
  print -u2 "$svc exists; not overwriting"
else
  pw=$(LC_ALL=C tr -dc 'A-Za-z0-9._%+=!?*@-' </dev/urandom | head -c 20)
  print -r -- "add-generic-password -a \"$USER\" -s \"$svc\" -w \"$pw\"" | security -i >/dev/null 2>&1
  unset pw
fi
```

Step 5, into the field that has the focus (`paste: false` keeps the value off the clipboard):

```zsh
security find-generic-password -a "$USER" -s "$svc" -w \
  | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read().rstrip("\n"), "paste": False}))' \
  | eyeshands hands type --owner <owner> --target <target> -
```

**Terms**
- **Keychain item**: one stored secret in the macOS Keychain, found by its account and service name.
- **`security -i`**: the macOS `security` tool in interactive mode. It reads its commands from
  stdin, so a value in a command does not show in `ps`.
- **System random source**: `/dev/urandom`, a cryptographically secure random number generator.

**Worked example**

A site asks for a new account in the middle of a form. The agent checks
`myproject:site:examplejobs`, finds no item, and makes one. It types the password into both
password fields with step 5 and submits the form. It reports only "created
myproject:site:examplejobs". Later sign-ins use step 5 again.

**Warnings**
- This applies only to new accounts that the agent makes on sites that the user approved. It never
  applies to the user's own main accounts, such as an Apple Account (Apple ID), Google, Microsoft, a bank or email.
  Never reset or change those passwords. Resetting an Apple Account signs out all of the user's devices.
  Ask the user instead.
- Keep quotes, backslashes and spaces out of the character set. They break the `security -i` line.
  If a site refuses the password, change the length or the other characters, not that rule.
- Never pass the password as a command argument, in an environment variable or in a file. Never
  print it to check it. To check an item, run `security find-generic-password` without `-w`.

**What to do next**

After the account works, add the service name to the profile's `secrets.md`.
