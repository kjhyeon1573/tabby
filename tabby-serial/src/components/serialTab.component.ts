/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector } from '@angular/core'
import { Platform, SelectorService } from 'tabby-core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent, NewlineMode } from 'tabby-terminal'
import { SerialSession, BAUD_RATES, SerialProfile } from '../api'

const INPUT_HISTORY_SIZE = 100

/** @hidden */
@Component({
    selector: 'serial-tab',
    template: `${BaseTerminalTabComponent.template} ${require('./serialTab.component.pug')}`,
    styleUrls: ['./serialTab.component.scss', ...BaseTerminalTabComponent.styles],
    animations: BaseTerminalTabComponent.animations,
})
export class SerialTabComponent extends ConnectableTerminalTabComponent<SerialProfile> {
    session: SerialSession|null = null
    Platform = Platform

    /** Line endings offered by the input bar; they drive the same option the terminal's Enter key uses */
    lineEndings: { name: string, value: NewlineMode }[] = [
        { name: 'CR', value: 'cr' },
        { name: 'LF', value: 'lf' },
        { name: 'CRLF', value: 'crlf' },
    ]

    baudRates = BAUD_RATES
    baudListId = `serial-baud-rates-${Math.random().toString(36).slice(2)}`
    inputLine = ''
    baudRateInput = ''

    private inputHistory: string[] = []
    /** Position while browsing the history with the arrow keys; -1 is the line being typed */
    private inputHistoryIndex = -1
    private pendingInputLine = ''

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (
        injector: Injector,
        private selector: SelectorService,
    ) {
        super(injector)
        this.enableToolbar = true
    }

    ngOnInit () {
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, hotkey => {
            if (!this.hasFocus) {
                return
            }
            switch (hotkey) {
                case 'home':
                    this.sendInput('\x1b[H' )
                    break
                case 'end':
                    this.sendInput('\x1b[F' )
                    break
                case 'restart-serial-session':
                    this.reconnect()
                    break
            }
        })

        super.ngOnInit()
        this.baudRateInput = this.profile.options.baudrate?.toString() ?? ''

        setImmediate(() => {
            this.setTitle(this.profile.name)
        })
    }

    async initializeSession () {
        super.initializeSession()

        const session = new SerialSession(this.injector, this.profile)
        this.setSession(session)

        this.startSpinner(this.translate.instant(_('Connecting')))

        try {
            await this.session!.start()
            this.stopSpinner()
            session.emitServiceMessage(this.translate.instant(_('Port opened')))
        } catch (e) {
            this.stopSpinner()
            this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
            return
        }
        this.session!.resize(this.size.columns, this.size.rows)
    }

    protected attachSessionHandlers () {
        this.attachSessionHandler(this.session!.serviceMessage$, msg => {
            this.write(`\r\n${colors.black.bgWhite(' Serial ')} ${msg}\r\n`)
            this.session?.resize(this.size.columns, this.size.rows)
        })
        super.attachSessionHandlers()
    }

    protected onSessionDestroyed (): void {
        if (this.frontend) {
            // Session was closed abruptly
            this.write('\r\n' + colors.black.bgWhite(' SERIAL ') + ` session closed\r\n`)

            super.onSessionDestroyed()
        }
    }

    get inputBarVisible (): boolean {
        return !!this.config.store.serial.inputBar
    }

    toggleInputBar (): void {
        this.config.store.serial.inputBar = !this.config.store.serial.inputBar
        this.config.save()
    }

    /** The newline the terminal's Enter key and the input bar send; a profile without the option sends CR */
    get lineEnding (): NewlineMode {
        return this.profile.options.inputNewlines ?? 'cr'
    }

    set lineEnding (value: NewlineMode) {
        this.profile.options.inputNewlines = value
    }

    /** Sends the input bar's line followed by the selected line ending, through the same path as typed input */
    sendInputLine (): void {
        if (!this.session?.open) {
            return
        }
        const line = this.inputLine
        this.sendInput(line + '\r')
        if (line) {
            this.inputHistory = this.inputHistory.filter(x => x !== line)
            this.inputHistory.push(line)
            if (this.inputHistory.length > INPUT_HISTORY_SIZE) {
                this.inputHistory.shift()
            }
        }
        this.inputHistoryIndex = -1
        this.inputLine = ''
    }

    /** Arrow keys in the input bar walk through previously sent lines */
    recallInput (direction: -1|1): void {
        if (!this.inputHistory.length) {
            return
        }
        if (this.inputHistoryIndex === -1) {
            if (direction === 1) {
                return
            }
            this.pendingInputLine = this.inputLine
            this.inputHistoryIndex = this.inputHistory.length
        }
        const index = this.inputHistoryIndex + direction
        if (index >= this.inputHistory.length) {
            this.inputHistoryIndex = -1
            this.inputLine = this.pendingInputLine
            return
        }
        if (index < 0) {
            return
        }
        this.inputHistoryIndex = index
        this.inputLine = this.inputHistory[index]
    }

    focusTerminal (): void {
        this.frontend?.focus()
    }

    /** Applies the rate typed into the input bar; any positive number is accepted, not only the presets */
    applyBaudRate (): void {
        const rate = parseInt(this.baudRateInput.replace(/[^\d]/g, ''))
        if (!rate || rate === this.profile.options.baudrate) {
            this.baudRateInput = this.profile.options.baudrate?.toString() ?? ''
            return
        }
        this.setBaudRate(rate)
    }

    async changeBaudRate () {
        const rate = await this.selector.show(
            this.translate.instant(_('Baud rate')),
            BAUD_RATES.map(x => ({
                name: x.toString(), result: x, weight: x,
            })),
        )
        this.setBaudRate(rate)
    }

    private setBaudRate (rate: number): void {
        const previous = this.profile.options.baudrate
        this.profile.options.baudrate = rate
        this.baudRateInput = rate.toString()
        if (!this.session?.serial) {
            return
        }
        this.session.serial.update({ baudRate: rate }, error => {
            if (!error) {
                return
            }
            this.zone.run(() => {
                this.notifications.error(error.message)
                this.profile.options.baudrate = previous
                this.baudRateInput = previous?.toString() ?? ''
            })
        })
    }

    protected isSessionExplicitlyTerminated (): boolean {
        return super.isSessionExplicitlyTerminated() ||
        this.recentInputs.endsWith('close\r') ||
        this.recentInputs.endsWith('quit\r')
    }
}
