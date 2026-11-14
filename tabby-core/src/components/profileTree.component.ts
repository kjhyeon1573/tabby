import { Component, HostBinding, HostListener, Input } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import deepClone from 'clone-deep'
import FuzzySearch from 'fuzzy-search'

import { ConfigService } from '../services/config.service'
import { ProfilesService } from '../services/profiles.service'
import { AppService } from '../services/app.service'
import { PlatformService } from '../api/platform'
import { ProfileProvider, ProfileStatus } from '../api/index'
import { BaseTabComponent } from './baseTab.component'
import { SplitTabComponent } from './splitTab.component'
import { PartialProfileGroup, ProfileGroup, PartialProfile, Profile } from '../index'
import { BaseComponent } from './base.component'

interface CollapsableProfileGroup extends ProfileGroup {
    collapsed: boolean
    children: PartialProfileGroup<CollapsableProfileGroup>[]
}

/** @hidden */
@Component({
    selector: 'profile-tree',
    styleUrls: ['./profileTree.component.scss'],
    templateUrl: './profileTree.component.pug',
})
export class ProfileTreeComponent extends BaseComponent {
    profileGroups: PartialProfileGroup<ProfileGroup>[] = []
    rootGroups: PartialProfileGroup<ProfileGroup>[] = []

    filteredProfiles: PartialProfile<Profile>[] = []
    @Input() filter = ''

    /** Live status per profile id, filled by ProfileProvider.getProfileStatus (e.g. tmux session exists) */
    profileStatus: Record<string, ProfileStatus|undefined> = {}
    activeProfileColor = 'var(--bs-green)'
    private statusTimer: ReturnType<typeof setInterval>|null = null


    panelMinWidth = 200
    panelMaxWidth = 600
    panelInternalWidth: number = parseInt(window.localStorage.profileTreeWidth ?? '300')
    panelStartWidth = this.panelInternalWidth
    panelIsResizing = false
    panelStartX = 0

    constructor (
        private app: AppService,
        private platform: PlatformService,
        private config: ConfigService,
        private profilesService: ProfilesService,
        private translate: TranslateService,
        private ngbModal: NgbModal,
    ) {
        super()
    }

    async ngOnInit (): Promise<void> {
        await this.loadTreeItems()
        this.subscribeUntilDestroyed(this.config.changed$, () => this.loadTreeItems())
        // tmux creates/destroys its session slightly after the tab appears/disappears, so re-check a few times
        this.subscribeUntilDestroyed(this.app.tabsChanged$, () => {
            for (const delay of [0, 500, 1500]) {
                setTimeout(() => this.refreshProfileStatus(), delay)
            }
        })
        this.statusTimer = setInterval(() => this.refreshProfileStatus(), 1000)
        this.app.tabsChanged$.subscribe(() => this.tabStateChanged())
        this.app.activeTabChange$.subscribe(() => this.tabStateChanged())
    }


    private async loadTreeItems (): Promise<void> {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        let groups = await this.profilesService.getProfileGroups({ includeNonUserGroup: true, includeProfiles: true })

        for (const group of groups) {
            if (group.profiles?.length) {
                // remove template profiles
                group.profiles = group.profiles.filter(x => !x.isTemplate)

                // remove blocklisted profiles
                group.profiles = group.profiles.filter(x => x.id && !this.config.store.profileBlacklist.includes(x.id))
            }
        }

        if (!this.config.store.terminal.showBuiltinProfiles) { groups = groups.filter(g => g.id !== 'built-in') }

        groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        groups.sort((a, b) => (a.id === 'built-in' || !a.editable ? 1 : 0) - (b.id === 'built-in' || !b.editable ? 1 : 0))
        groups.sort((a, b) => (a.id === 'ungrouped' ? 0 : 1) - (b.id === 'ungrouped' ? 0 : 1))
        this.profileGroups = groups.map(g => ProfileTreeComponent.intoPartialCollapsableProfileGroup(g, profileGroupCollapsed[g.id] ?? false))
        this.rootGroups = this.profilesService.buildGroupTree(this.profileGroups)
        this.refreshProfileStatus()
    }

    private async editProfile (profile: PartialProfile<Profile>): Promise<void> {
        const { EditProfileModalComponent } = window['nodeRequire']('tabby-settings')
        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )

        const provider = this.profilesService.providerForProfile(profile)
        if (!provider) { throw new Error('Cannot edit a profile without a provider') }

        modal.componentInstance.partialProfile = deepClone({ ...profile })
        modal.componentInstance.profileProvider = provider

        const result = await modal.result.catch(() => null)
        if (!result) { return }

        result.type = provider.id

        await this.profilesService.writeProfile(result)
        await this.config.save()
    }

    private async editProfileGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const { EditProfileGroupModalComponent } = window['nodeRequire']('tabby-settings')

        const modal = this.ngbModal.open(
            EditProfileGroupModalComponent,
            { size: 'lg' },
        )

        modal.componentInstance.group = deepClone(group)
        modal.componentInstance.providers = this.profilesService.getProviders()

        const result: PartialProfileGroup<ProfileGroup & { group: PartialProfileGroup<CollapsableProfileGroup>, provider?: ProfileProvider<Profile> }> | null = await modal.result.catch(() => null)
        if (!result) { return }
        if (!result.group) { return }

        if (result.provider) {
            return this.editProfileGroupDefaults(result.group, result.provider)
        }

        delete result.group.collapsed
        delete result.group.children
        await this.profilesService.writeProfileGroup(result.group)
        await this.config.save()
    }

    private async editProfileGroupDefaults (group: PartialProfileGroup<CollapsableProfileGroup>, provider: ProfileProvider<Profile>): Promise<void> {
        const { EditProfileModalComponent } = window['nodeRequire']('tabby-settings')

        const modal = this.ngbModal.open(
            EditProfileModalComponent,
            { size: 'lg' },
        )
        const model = group.defaults?.[provider.id] ?? {}
        model.type = provider.id
        modal.componentInstance.profile = Object.assign({}, model)
        modal.componentInstance.profileProvider = provider
        modal.componentInstance.defaultsMode = 'group'

        const result = await modal.result.catch(() => null)
        if (result) {
            // Fully replace the config
            for (const k in model) {
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                delete model[k]
            }
            Object.assign(model, result)
            if (!group.defaults) {
                group.defaults = {}
            }
            group.defaults[provider.id] = model
        }
        return this.editProfileGroup(group)
    }

    async profileContextMenu (profile: PartialProfile<Profile>, event: MouseEvent): Promise<void> {
        event.preventDefault()

        this.platform.popupContextMenu([
            {
                type: 'normal',
                label: this.translate.instant('Run'),
                click: () => this.launchProfile(profile),
            },
            {
                type: 'normal',
                label: this.translate.instant('Edit profile'),
                click: () => this.editProfile(profile),
                enabled: !(profile.isBuiltin ?? profile.isTemplate),
            },
        ])
    }

    async groupContextMenu (group: PartialProfileGroup<CollapsableProfileGroup>, event: MouseEvent): Promise<void> {
        event.preventDefault()
        this.platform.popupContextMenu([
            {
                type: 'normal',
                label: group.collapsed ? this.translate.instant('Expand group') : this.translate.instant('Collapse group'),
                click: () => this.toggleGroupCollapse(group),
            },
            {
                type: 'normal',
                label: this.translate.instant('Edit group'),
                click: () => this.editProfileGroup(group),
                enabled: group.editable,
            },
        ])
    }

    private async tabStateChanged (): Promise<void> {
        // TODO: show active tab in the side panel with eye icon
    }

    ngOnDestroy (): void {
        if (this.statusTimer) {
            clearInterval(this.statusTimer)
            this.statusTimer = null
        }
        super.ngOnDestroy()
    }

    async launchProfile<P extends Profile> (profile: PartialProfile<P>): Promise<any> {
        // Stateful profiles (e.g. a named tmux session) get a single tab: focus it if it is already open
        if (profile.id && this.profileStatus[profile.id]) {
            const existing = this.findOpenTabForProfile(profile)
            if (existing) {
                this.app.selectTab(existing.top)
                if (existing.top instanceof SplitTabComponent) {
                    existing.top.focus(existing.tab)
                }
                return
            }
        }
        return this.profilesService.launchProfile(profile)
    }

    onProfileRowEnter (event: MouseEvent): void {
        this.setRowHovered(event.currentTarget as HTMLElement, true)
    }

    onProfileRowLeave (event: MouseEvent): void {
        this.setRowHovered(event.currentTarget as HTMLElement, false)
    }

    /**
     * Moves the path label between its inline slot and the second line. The label itself is
     * FLIP-animated; a quad behind it follows with kitty's cursor-trail corner dynamics so the
     * move reads as a stretch from the old position to the new one rather than a swap.
     */
    private setRowHovered (row: HTMLElement, hovered: boolean): void {
        const detail = row.querySelector<HTMLElement>('.profile-detail')
        if (!detail) {
            row.classList.toggle('hovered', hovered)
            return
        }
        this.stopMarquee(detail)
        detail.getAnimations().forEach(a => a.cancel())

        const rowBefore = row.getBoundingClientRect()
        const first = detail.getBoundingClientRect()
        row.style.height = ''
        row.classList.toggle('hovered', hovered)
        const rowAfter = row.getBoundingClientRect()
        const last = detail.getBoundingClientRect()

        // row height
        if (Math.abs(rowBefore.height - rowAfter.height) > 0.5) {
            row.style.transition = 'none'
            row.style.height = `${rowBefore.height}px`
            void row.offsetHeight
            row.style.transition = 'height .24s cubic-bezier(.2, .8, .2, 1)'
            row.style.height = `${rowAfter.height}px`
            setTimeout(() => {
                if (row.classList.contains('hovered') === hovered) {
                    row.style.height = ''
                    row.style.transition = ''
                }
            }, 260)
        }

        // label: start where it was, ease into the new slot
        detail.animate([
            { transform: `translate(${first.left - last.left}px, ${first.top - last.top}px)` },
            { transform: 'none' },
        ], { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' })

        const rel = (r: DOMRect) => ({ x: r.left - rowAfter.left, y: r.top - rowAfter.top, w: r.width, h: r.height })
        this.runDetailTrail(row, rel(first), rel(last))

        if (hovered) {
            setTimeout(() => {
                if (row.classList.contains('hovered')) {
                    this.startMarquee(detail)
                }
            }, 300)
        }
    }

    private detailTrails = new WeakMap<HTMLElement, number>()

    private runDetailTrail (row: HTMLElement, from: { x: number, y: number, w: number, h: number }, to: { x: number, y: number, w: number, h: number }): void {
        let layer = row.querySelector<HTMLElement>('.detail-trail')
        if (!layer) {
            layer = document.createElement('div')
            layer.className = 'detail-trail'
            row.appendChild(layer)
        }
        const running = this.detailTrails.get(row)
        if (running) {
            cancelAnimationFrame(running)
        }

        // corners: top-right, bottom-right, bottom-left, top-left (same order as kitty)
        const cx = [from.x + from.w, from.x + from.w, from.x, from.x]
        const cy = [from.y, from.y + from.h, from.y + from.h, from.y]
        const tx = [to.x + to.w, to.x + to.w, to.x, to.x]
        const ty = [to.y, to.y + to.h, to.y + to.h, to.y]
        const centerX = to.x + to.w / 2
        const centerY = to.y + to.h / 2
        const diag2 = Math.hypot(to.w, to.h) / 2 || 1
        const decayFast = 0.08
        const decaySlow = 0.32
        let lastTime = performance.now()
        layer.style.display = 'block'

        const step = (now: number) => {
            const dt = Math.min(1 / 30, (now - lastTime) / 1000)
            lastTime = now
            const dx: number[] = []
            const dy: number[] = []
            const dot: number[] = []
            let minDot = Infinity
            let maxDot = -Infinity
            for (let i = 0; i < 4; i++) {
                dx[i] = tx[i] - cx[i]
                dy[i] = ty[i] - cy[i]
                const n = Math.hypot(dx[i], dy[i])
                dot[i] = n < 1e-6 ? 0 : (dx[i] * (tx[i] - centerX) + dy[i] * (ty[i] - centerY)) / diag2 / n
                minDot = Math.min(minDot, dot[i])
                maxDot = Math.max(maxDot, dot[i])
            }
            let settled = true
            for (let i = 0; i < 4; i++) {
                if (Math.abs(dx[i]) < 0.5 && Math.abs(dy[i]) < 0.5) {
                    cx[i] = tx[i]
                    cy[i] = ty[i]
                    continue
                }
                settled = false
                const decay = maxDot - minDot < 1e-6 ? decaySlow : decaySlow + (decayFast - decaySlow) * (dot[i] - minDot) / (maxDot - minDot)
                const s = 1 - Math.pow(2, -10 * dt / decay)
                cx[i] += dx[i] * s
                cy[i] += dy[i] * s
            }
            layer!.style.clipPath = `polygon(${cx[0]}px ${cy[0]}px, ${cx[1]}px ${cy[1]}px, ${cx[2]}px ${cy[2]}px, ${cx[3]}px ${cy[3]}px)`
            if (settled) {
                layer!.style.display = 'none'
                this.detailTrails.delete(row)
            } else {
                this.detailTrails.set(row, requestAnimationFrame(step))
            }
        }
        this.detailTrails.set(row, requestAnimationFrame(step))
    }

    /** Scrolls the full path when it does not fit the row */
    private startMarquee (detail: HTMLElement): void {
        const track = detail.querySelector<HTMLElement>('.detail-track')
        if (!track) {
            return
        }
        const overflow = track.scrollWidth - detail.clientWidth
        if (overflow > 2) {
            detail.style.setProperty('--marquee-distance', `${-(overflow + 8)}px`)
            detail.style.setProperty('--marquee-duration', `${Math.max(5, overflow / 22 + 3).toFixed(1)}s`)
            detail.classList.add('marquee')
        }
    }

    private stopMarquee (detail: HTMLElement): void {
        detail.classList.remove('marquee')
        detail.style.removeProperty('--marquee-distance')
        detail.style.removeProperty('--marquee-duration')
    }

    /** '~/a/b/c' -> ['~/a/b/', 'c']: the sidebar shows only the last segment until hovered */
    splitDetail (detail: string): [string, string] {
        const idx = detail.lastIndexOf('/')
        if (idx < 0 || idx === detail.length - 1) {
            return ['', detail]
        }
        return [detail.slice(0, idx + 1), detail.slice(idx + 1)]
    }

    private findOpenTabForProfile (profile: PartialProfile<Profile>): { top: BaseTabComponent, tab: BaseTabComponent }|null {
        for (const top of this.app.tabs) {
            const leaves = top instanceof SplitTabComponent ? top.getAllTabs() : [top]
            for (const tab of leaves) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
                const tabProfileID = (tab as any).profile?.id
                if (tabProfileID && tabProfileID === profile.id) {
                    return { top, tab }
                }
            }
        }
        return null
    }

    private async refreshProfileStatus (): Promise<void> {
        const next: Record<string, ProfileStatus|undefined> = {}
        const profiles = this.profileGroups.flatMap(g => g.profiles ?? [])
        await Promise.all(profiles.map(async profile => {
            if (!profile.id) {
                return
            }
            const provider = this.profilesService.providerForProfile(profile)
            const status = await provider?.getProfileStatus(profile).catch(() => null)
            if (status) {
                next[profile.id] = status
            }
        }))
        this.profileStatus = next
    }

    async onFilterChange (): Promise<void> {
        try {
            const q = this.filter.trim().toLowerCase()

            if (q.length === 0) {
                this.rootGroups = this.profilesService.buildGroupTree(this.profileGroups)
                return
            }

            const profiles = await this.profilesService.getProfiles({
                includeBuiltin: this.config.store.terminal.showBuiltinProfiles,
                clone: true,
            })

            const matches = new FuzzySearch(
                profiles.filter(p => !p.isTemplate),
                ['name', 'description'],
                { sort: false },
            ).search(q)

            this.rootGroups = [
                {
                    id: 'search',
                    editable: false,
                    name: this.translate.instant('Filter results'),
                    icon: 'fas fa-magnifying-glass',
                    profiles: matches,
                },
            ]
        } catch (error) {
            console.error('Error occurred during search:', error)
        }
    }

    ////// RESIZING //////
    startResize (event: MouseEvent): void {
        this.panelIsResizing = true
        this.panelStartX = event.clientX
        this.panelStartWidth = this.panelWidth
        event.preventDefault()
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove (event: MouseEvent): void {
        if (!this.panelIsResizing) { return }
        const delta = event.clientX - this.panelStartX
        const width = Math.min(Math.max(this.panelMinWidth, this.panelStartWidth + delta), this.panelMaxWidth)
        this.panelWidth = width
        window.localStorage.profileTreeWidth = width
    }

    @HostListener('document:mouseup')
    stopResize (): boolean {
        this.panelIsResizing = false
        return true
    }

    @HostBinding('style.width.px')
    get panelWidth (): number {
        return this.panelInternalWidth
    }

    set panelWidth (value: number) {
        this.panelInternalWidth = value
    }

    ////// GROUP COLLAPSING //////
    toggleGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        group.collapsed = !group.collapsed
        this.saveProfileGroupCollapse(group)
    }

    private saveProfileGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        const profileGroupCollapsed = JSON.parse(window.localStorage.profileGroupCollapsed ?? '{}')
        profileGroupCollapsed[group.id] = group.collapsed
        window.localStorage.profileGroupCollapsed = JSON.stringify(profileGroupCollapsed)
    }

    private static intoPartialCollapsableProfileGroup (group: PartialProfileGroup<ProfileGroup>, collapsed: boolean): PartialProfileGroup<CollapsableProfileGroup> {
        const collapsableGroup = {
            ...group,
            collapsed,
        }
        return collapsableGroup
    }

}
