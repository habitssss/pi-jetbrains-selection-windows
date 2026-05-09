# Pi JetBrains Selection Windows

Send the current JetBrains IDE file location to the Pi input box with a keyboard shortcut.

Example text inserted into Pi:

```text
server/src/main/java/example/UserService.java:120-145
server/src/main/java/example/UserService.java:120
```

## Platform support

**Windows only.**

This repository uses a PowerShell script and JetBrains External Tools configuration for Windows. macOS and Linux are not supported yet.

## What is sent

This tool sends only a compact file reference:

```text
<project-relative-path>:<line>
<project-relative-path>:<start-line>-<end-line>
```

It does **not** send the selected code content.

## How it works

- `idea-selection.ts` is a Pi extension.
- The extension listens on `127.0.0.1:17373` by default.
- `send-idea-selection.ps1` is called by JetBrains External Tools.
- The script reads JetBrains macros such as `$FilePath$`, `$SelectionStartLine$`, and `$SelectionEndLine$`.
- The script posts the generated file reference to the Pi extension.
- The extension appends the reference to the Pi input editor.

## Install

### Option 1: Copy files manually

Create the Pi extension and script directories if they do not exist:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.pi\agent\extensions"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.pi\agent\scripts"
```

Copy files:

```powershell
Copy-Item .\idea-selection.ts "$env:USERPROFILE\.pi\agent\extensions\idea-selection.ts"
Copy-Item .\send-idea-selection.ps1 "$env:USERPROFILE\.pi\agent\scripts\send-idea-selection.ps1"
```

Then reload Pi:

```text
/reload
```

You should see a message similar to:

```text
IDEA selection listener: http://127.0.0.1:17373/idea-selection
```

### Option 2: Clone then copy

```powershell
git clone https://github.com/habitssss/pi-jetbrains-selection-windows.git
cd pi-jetbrains-selection-windows

New-Item -ItemType Directory -Force "$env:USERPROFILE\.pi\agent\extensions"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.pi\agent\scripts"

Copy-Item .\idea-selection.ts "$env:USERPROFILE\.pi\agent\extensions\idea-selection.ts"
Copy-Item .\send-idea-selection.ps1 "$env:USERPROFILE\.pi\agent\scripts\send-idea-selection.ps1"
```

Reload Pi:

```text
/reload
```

## Configure JetBrains IDE

This works with IntelliJ IDEA and should also work with other JetBrains IDEs that support External Tools.

Open:

```text
Settings → Tools → External Tools → +
```

Use this configuration:

**Name**

```text
Send Selection To Pi
```

**Program**

```text
powershell.exe
```

If you use PowerShell 7, `pwsh.exe` should also work.

**Arguments**

```text
-NoProfile -ExecutionPolicy Bypass -File "$USER_HOME$\.pi\agent\scripts\send-idea-selection.ps1" -FilePath "$FilePath$" -ProjectDir "$ProjectFileDir$" -SelectionStartLine "$SelectionStartLine$" -SelectionEndLine "$SelectionEndLine$" -LineNumber "$LineNumber$"
```

**Working directory**

```text
$ProjectFileDir$
```

If your IDE does not expand `$ProjectFileDir$` correctly, leave the working directory empty or set it to your real project root path.

If the generated path is too broad or too narrow, replace this part of the arguments:

```text
-ProjectDir "$ProjectFileDir$"
```

with your preferred project or module root path, for example:

```text
-ProjectDir "C:\path\to\project"
```

Do not use a path containing secrets.

### Bind a keyboard shortcut

Open:

```text
Settings → Keymap → External Tools → Send Selection To Pi
```

Bind a shortcut, for example:

```text
Alt+P
```

Optional: disable the External Tool console popup by unchecking:

```text
Open console for tool output
```

## Usage

1. Start Pi in interactive mode.
2. Select code in the JetBrains editor.
3. Press your configured shortcut, for example `Alt+P`.
4. Pi receives one line like:

```text
src/main/java/example/UserService.java:120-145
```

If no code is selected, the current caret line is sent:

```text
src/main/java/example/UserService.java:120
```

Multiple shortcut presses append multiple lines.

## Custom port

The default port is `17373`.

To use another port, set the same environment variable for both the Pi process and the JetBrains IDE process:

```powershell
$env:PI_IDEA_SELECTION_PORT = "17374"
```

If you set a persistent Windows environment variable, restart JetBrains IDE and Pi so both processes see the same value.

## Fallback behavior

If Pi is not running or the extension is not listening, the PowerShell script copies the generated file reference to the Windows clipboard and shows a short popup.

## Security notes

- The extension listens only on `127.0.0.1`.
- Do not change it to `0.0.0.0` unless you add proper authentication and understand the risk.
- There is no token authentication by default because this is intended for local personal use.
- The script sends only file paths relative to your configured project root and line numbers.
- The selected code content is not sent.
