/* eslint-disable @typescript-eslint/no-type-alias */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-empty-function */
import { BaseTabComponent } from '../components/baseTab.component'
import { NewTabParameters } from '../services/tabs.service'
import { FullyDefined } from '../services/config.service'

export interface Profile {
    id: string
    type: string
    name: string
    group: string
    options: any

    icon: string | null
    color: string | null
    disableDynamicTitle: boolean
    behaviorOnSessionEnd: 'auto'|'keep'|'reconnect'|'close'

    weight: number
    isBuiltin: boolean
    isTemplate: boolean
}

export interface ConnectableProfile extends Profile {
    clearServiceMessagesOnConnect: boolean
}

export type PartialProfile<T extends Profile> = Omit<Omit<Omit<{
    [K in keyof T]?: T[K]
}, 'options'>, 'type'>, 'name'> & {
    type: string
    name: string
    options?: {
        [K in keyof T['options']]?: T['options'][K]
    }
}

export interface ProfileGroup {
    id: string
    parentGroupId?: string
    icon?: string
    color?: string
    name: string
    profiles: PartialProfile<Profile>[]
    defaults: any
    editable: boolean
}

export type PartialProfileGroup<T extends ProfileGroup> = Omit<Omit<{
    [K in keyof T]?: T[K]
}, 'id'>, 'name'> & {
    id: string
    name: string
}

export interface ProfileSettingsComponent<P extends Profile, PP extends ProfileProvider<P>> {
    profile: FullyDefined<P>
    save?: () => void
}

/** Live state of a profile shown in the profile sidebar (e.g. whether its tmux session exists) */
export interface ProfileStatus {
    active: boolean
    description?: string
    /** Short secondary text shown next to the profile name, e.g. the session's current directory */
    detail?: string
}

export abstract class ProfileProvider<P extends Profile> {
    id: string
    name: string
    settingsComponent?: new (...args: any[]) => ProfileSettingsComponent<P, ProfileProvider<P>>
    configDefaults: Pick<Profile, 'options'>

    abstract getBuiltinProfiles (): Promise<PartialProfile<P>[]>

    abstract getNewTabParameters (profile: P): Promise<NewTabParameters<BaseTabComponent>>

    getSuggestedName (profile: PartialProfile<P>): string|null {
        return null
    }

    abstract getDescription (profile: PartialProfile<P>): string

    /**
     * Optional live status for the profile sidebar.
     * Return null when the profile has no notion of a persistent state.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async getProfileStatus (_profile: PartialProfile<P>): Promise<ProfileStatus|null> {
        return null
    }

    deleteProfile (profile: P): void { }
}

export abstract class ConnectableProfileProvider<P extends ConnectableProfile> extends ProfileProvider<P> {}

export abstract class QuickConnectProfileProvider<P extends ConnectableProfile> extends ConnectableProfileProvider<P> {

    abstract quickConnect (query: string): PartialProfile<P>|null

    abstract intoQuickConnectString (profile: P): string|null

}
