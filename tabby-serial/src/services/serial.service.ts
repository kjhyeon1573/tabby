import { Injectable } from '@angular/core'
import WSABinding from 'serialport-binding-webserialapi'
import AbstractBinding from '@serialport/binding-abstract'
import { autoDetect } from '@serialport/bindings-cpp'
import { ConfigService, HostAppService, Platform } from 'tabby-core'
import { SerialPortInfo, BAUD_RATES } from '../api'

@Injectable({ providedIn: 'root' })
export class SerialService {
    private constructor (
        private hostApp: HostAppService,
        private config: ConfigService,
    ) { }

    /** Preset baud rates plus the ones the user added (config `serial.customBaudRates`), ascending */
    getBaudRates (): number[] {
        const custom: number[] = this.config.store.serial?.customBaudRates ?? []
        return [...new Set([...BAUD_RATES, ...custom])].filter(x => x > 0).sort((a, b) => a - b)
    }

    /** Remembers a rate so every baud rate picker offers it */
    async addBaudRate (rate: number): Promise<void> {
        if (!rate || this.getBaudRates().includes(rate)) {
            return
        }
        const custom: number[] = this.config.store.serial.customBaudRates ?? []
        this.config.store.serial.customBaudRates = [...custom, rate].sort((a, b) => a - b)
        await this.config.save()
    }

    detectBinding (): typeof AbstractBinding {
        return this.hostApp.platform === Platform.Web ? WSABinding : autoDetect()
    }

    async listPorts (): Promise<SerialPortInfo[]> {
        try {
            return (await this.detectBinding().list()).map(x => ({
                name: x.path,
                description: `${x.manufacturer ?? ''} ${x.serialNumber ?? ''}`.trim() || undefined,
            }))
        } catch (err) {
            console.error('Failed to list serial ports', err)
            return []
        }
    }
}
