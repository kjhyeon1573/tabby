import * as path from 'path'
import { execFile } from 'mz/child_process'
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import deepClone from 'clone-deep'
import { Injectable, Inject } from '@angular/core'
import { ProfileProvider, NewTabParameters, ConfigService, SplitTabComponent, AppService, PartialProfile, ProfileStatus } from 'tabby-core'
import { TerminalTabComponent } from './components/terminalTab.component'
import { LocalProfileSettingsComponent } from './components/localProfileSettings.component'
import { ShellProvider, Shell, SessionOptions, LocalProfile } from './api'

interface TmuxSessionInfo {
    cwd: string
    currentCommand: string
    shellPID: number
    attention: boolean
    working: boolean
    /** Unix time (ms) of the window's last output */
    activityAt: number
    sshDestination?: string
    sshCommandLine?: string
}

/**
 * tmux session option that asks the sidebar for attention, e.g. from a Claude Code Stop hook:
 * `tmux set-option -t "$TMUX_PANE" @tabby-attention 1` (cleared when the profile's tab is viewed)
 */
const TMUX_ATTENTION_OPTION = '@tabby-attention'

/**
 * tmux session option set while something works in the session, e.g. from a Claude Code
 * UserPromptSubmit hook (unset again by its Stop / Notification hooks)
 */
const TMUX_WORKING_OPTION = '@tabby-working'

/**
 * @tabby-working only counts while the session keeps producing output (Claude's spinner redraws
 * constantly), so an interrupted reply that never reaches the Stop hook stops showing as working
 */
const WORKING_ACTIVITY_TIMEOUT_MS = 20000

/** Foreground commands that mean the pane is idle at a prompt */
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'xonsh', 'elvish', 'pwsh', 'tmux'])

/**
 * Long-lived interactive programs: running them is not a job in progress, so they neither show as
 * busy nor flag the profile when they exit. Claude reports its own state through the hook options.
 */
const INTERACTIVE_COMMANDS = new Set([
    'claude', 'vim', 'nvim', 'vi', 'view', 'nano', 'micro', 'hx', 'emacs', 'less', 'more', 'most', 'man',
    'top', 'htop', 'btop', 'atop', 'ssh', 'mosh', 'mosh-client', 'telnet', 'lazygit', 'tig', 'ranger', 'yazi', 'nnn', 'mc',
])

interface ProcessInfo {
    pid: number
    ppid: number
    args: string
}

@Injectable({ providedIn: 'root' })
export class LocalProfilesService extends ProfileProvider<LocalProfile> {
    id = 'local'
    name = _('Local terminal')
    settingsComponent = LocalProfileSettingsComponent
    configDefaults = {
        options: {
            restoreFromPTYID: null,
            command: '',
            args: [],
            homeDirArgs: [],
            cwd: null,
            env: {
                __nonStructural: true,
            },
            width: null,
            height: null,
            shellType: null,
            pauseAfterExit: false,
            runAsAdministrator: false,
            fsBase: null,
        },
    }

    constructor (
        private app: AppService,
        private config: ConfigService,
        @Inject(ShellProvider) private shellProviders: ShellProvider[],
    ) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<LocalProfile>[]> {
        return (await this.getShells()).map(shell => ({
            id: `local:${shell.id}`,
            type: 'local',
            name: shell.name,
            icon: shell.icon,
            options: this.optionsFromShell(shell),
            isBuiltin: true,
        }))
    }

    private tmuxSessionsCache: { at: number, command: string, sessions: Promise<Map<string, TmuxSessionInfo>> }|null = null

    /** For profiles that run `tmux new-session -s NAME` / `tmux attach -t NAME`: reports whether NAME exists */
    async getProfileStatus (profile: PartialProfile<LocalProfile>): Promise<ProfileStatus|null> {
        const session = this.getTmuxSessionName(profile)
        if (session === null) {
            return null
        }
        const sessions = await this.listTmuxSessions(profile.options?.command ?? 'tmux')
        const info = sessions.get(session)
        if (!info) {
            return { active: false, description: `tmux session "${session}" is not running` }
        }
        const flags = {
            attention: info.attention,
            working: info.working && Date.now() - info.activityAt < WORKING_ACTIVITY_TIMEOUT_MS,
            busy: this.isJobCommand(info.currentCommand),
        }
        if (info.sshDestination) {
            const host = info.sshDestination.replace(/^.*@/, '').replace(/:\d+$/, '')
            return {
                active: true,
                description: `tmux session "${session}" is connected to ${info.sshDestination} over ssh: ${info.sshCommandLine}`,
                detail: info.sshCommandLine ?? `ssh ${info.sshDestination}`,
                detailShort: host,
                ...flags,
            }
        }
        return {
            active: true,
            description: `tmux session "${session}" is running${info.cwd ? ` in ${info.cwd}` : ''}`,
            detail: info.cwd ? this.abbreviateHome(info.cwd) : undefined,
            ...flags,
        }
    }

    private isJobCommand (command: string): boolean {
        const name = command.replace(/^-/, '')
        return !!name && !SHELL_COMMANDS.has(name) && !INTERACTIVE_COMMANDS.has(name)
    }

    async clearProfileAttention (profile: PartialProfile<LocalProfile>): Promise<void> {
        const session = this.getTmuxSessionName(profile)
        if (session === null) {
            return
        }
        // `=NAME:` matches the session name exactly, so numeric names are not read as window indexes
        await execFile(profile.options?.command ?? 'tmux', ['set-option', '-t', `=${session}:`, '-u', TMUX_ATTENTION_OPTION])
        this.tmuxSessionsCache = null
    }

    getTmuxSessionName (profile: PartialProfile<LocalProfile>): string|null {
        const command = profile.options?.command ?? ''
        if (path.basename(command) !== 'tmux') {
            return null
        }
        const args = (profile.options?.args ?? []).map(String)
        for (let i = 0; i < args.length - 1; i++) {
            if (args[i] === '-s' || args[i] === '-t') {
                return args[i + 1].replace(/^=/, '')
            }
        }
        return null
    }

    private abbreviateHome (dir: string): string {
        const home = process.env.HOME
        if (home && (dir === home || dir.startsWith(home + '/'))) {
            return '~' + dir.slice(home.length)
        }
        return dir
    }

    /** session name -> state of the session's active pane */
    private listTmuxSessions (command: string): Promise<Map<string, TmuxSessionInfo>> {
        const now = Date.now()
        if (!this.tmuxSessionsCache || this.tmuxSessionsCache.command !== command || now - this.tmuxSessionsCache.at > 300) {
            this.tmuxSessionsCache = {
                at: now,
                command,
                sessions: this.queryTmuxSessions(command).catch(() => new Map<string, TmuxSessionInfo>()),
            }
        }
        return this.tmuxSessionsCache.sessions
    }

    private async queryTmuxSessions (command: string): Promise<Map<string, TmuxSessionInfo>> {
        const [stdout] = await execFile(command, ['list-sessions', '-F', `#S\t#{pane_pid}\t#{pane_current_command}\t#{${TMUX_ATTENTION_OPTION}}\t#{${TMUX_WORKING_OPTION}}\t#{window_activity}\t#{pane_current_path}`])
        const sessions = new Map<string, TmuxSessionInfo>()
        for (const line of stdout.toString().split('\n').filter(x => x)) {
            const [name, pid, currentCommand, attention, working, activity, ...rest] = line.split('\t')
            sessions.set(name, {
                cwd: rest.join('\t'),
                currentCommand,
                shellPID: parseInt(pid),
                attention: !!attention && attention !== '0',
                working: !!working && working !== '0',
                activityAt: parseInt(activity) * 1000 || 0,
            })
        }

        // When the pane's foreground program is ssh, show where it is connected instead of the
        // (meaningless) local directory of the ssh process
        const sshSessions = [...sessions.values()].filter(x => x.currentCommand === 'ssh' && x.shellPID)
        if (sshSessions.length) {
            const processes = await this.listProcesses()
            for (const info of sshSessions) {
                const ssh = this.findSSHProcess(info.shellPID, processes)
                if (ssh) {
                    info.sshDestination = this.parseSSHDestination(ssh.argv.slice(1)) ?? undefined
                    info.sshCommandLine = ['ssh', ...ssh.argv.slice(1)].join(' ')
                }
            }
        }
        return sessions
    }

    private async listProcesses (): Promise<ProcessInfo[]> {
        const [stdout] = await execFile('ps', ['-axo', 'pid=,ppid=,args='])
        return stdout.toString().split('\n').map(line => {
            const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
            return m ? { pid: parseInt(m[1]), ppid: parseInt(m[2]), args: m[3] } : null
        }).filter((x): x is ProcessInfo => !!x)
    }

    /** Walks the pane shell's descendants and returns the first ssh process found */
    private findSSHProcess (shellPID: number, processes: ProcessInfo[]): { argv: string[] }|null {
        const queue = [shellPID]
        const seen = new Set<number>()
        while (queue.length) {
            const pid = queue.shift()!
            if (seen.has(pid)) {
                continue
            }
            seen.add(pid)
            for (const proc of processes) {
                if (proc.ppid !== pid) {
                    continue
                }
                const argv = proc.args.split(/\s+/)
                if (path.basename(argv[0]) === 'ssh') {
                    return { argv }
                }
                queue.push(proc.pid)
            }
        }
        return null
    }

    /** First positional argument of an ssh command line, skipping options that take a value */
    private parseSSHDestination (args: string[]): string|null {
        const optionsWithValue = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w'])
        let user: string|null = null
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === '--') {
                return args[i + 1] ?? null
            }
            if (arg.startsWith('-')) {
                if (arg === '-l') {
                    user = args[++i] ?? null
                } else if (optionsWithValue.has(arg.slice(0, 2)) && arg.length === 2) {
                    i++
                }
                continue
            }
            const destination = arg.replace(/^ssh:\/\//, '').replace(/\/.*$/, '')
            return user && !destination.includes('@') ? `${user}@${destination}` : destination
        }
        return null
    }

    async getNewTabParameters (profile: LocalProfile): Promise<NewTabParameters<TerminalTabComponent>> {
        profile = deepClone({ ...profile })

        if (!profile.options.cwd) {
            if (this.app.activeTab instanceof TerminalTabComponent && this.app.activeTab.session) {
                profile.options.cwd = await this.app.activeTab.session.getWorkingDirectory() ?? null
            }
            if (this.app.activeTab instanceof SplitTabComponent) {
                const focusedTab = this.app.activeTab.getFocusedTab()

                if (focusedTab instanceof TerminalTabComponent && focusedTab.session) {
                    profile.options.cwd = await focusedTab.session.getWorkingDirectory() ?? null
                }
            }
        }

        return {
            type: TerminalTabComponent,
            inputs: {
                profile,
            },
        }
    }

    async getShells (): Promise<Shell[]> {
        const shellLists = await Promise.all(this.config.enabledServices(this.shellProviders).map(x => x.provide()))
        return shellLists.reduce((a, b) => a.concat(b), [])
    }

    optionsFromShell (shell: Shell): SessionOptions {
        return {
            ...this.configDefaults.options,
            command: shell.command,
            args: shell.args ?? [],
            homeDirArgs: shell.homeDirArgs ?? [],
            env: shell.env,
            cwd: shell.cwd ?? null,
            shellType: shell.shellType ?? null,
            fsBase: shell.fsBase ?? null,
        }
    }

    getSuggestedName (profile: LocalProfile): string {
        return this.getDescription(profile)
    }

    getDescription (profile: PartialProfile<LocalProfile>): string {
        return profile.options?.command ?? ''
    }
}
