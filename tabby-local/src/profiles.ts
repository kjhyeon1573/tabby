import * as path from 'path'
import { execFile } from 'mz/child_process'
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import deepClone from 'clone-deep'
import { Injectable, Inject } from '@angular/core'
import { ProfileProvider, NewTabParameters, ConfigService, SplitTabComponent, AppService, PartialProfile, ProfileStatus } from 'tabby-core'
import { TerminalTabComponent } from './components/terminalTab.component'
import { LocalProfileSettingsComponent } from './components/localProfileSettings.component'
import { ShellProvider, Shell, SessionOptions, LocalProfile } from './api'

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

    private tmuxSessionsCache: { at: number, command: string, sessions: Promise<Set<string>> }|null = null

    /** For profiles that run `tmux new-session -s NAME` / `tmux attach -t NAME`: reports whether NAME exists */
    async getProfileStatus (profile: PartialProfile<LocalProfile>): Promise<ProfileStatus|null> {
        const session = this.getTmuxSessionName(profile)
        if (session === null) {
            return null
        }
        const sessions = await this.listTmuxSessions(profile.options?.command ?? 'tmux')
        const active = sessions.has(session)
        return {
            active,
            description: active ? `tmux session "${session}" is running` : `tmux session "${session}" is not running`,
        }
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

    private listTmuxSessions (command: string): Promise<Set<string>> {
        const now = Date.now()
        if (!this.tmuxSessionsCache || this.tmuxSessionsCache.command !== command || now - this.tmuxSessionsCache.at > 2000) {
            this.tmuxSessionsCache = {
                at: now,
                command,
                sessions: execFile(command, ['list-sessions', '-F', '#S'])
                    .then(([stdout]) => new Set(stdout.toString().split('\n').filter(x => x)))
                    .catch(() => new Set<string>()),
            }
        }
        return this.tmuxSessionsCache.sessions
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
