import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class SerialConfigProvider extends ConfigProvider {
    defaults = {
        hotkeys: {
            serial: [
                'Alt-K',
            ],
            'restart-serial-session': [],
        },
        serial: {
            /** Show the send line / line ending / baud rate bar under serial terminals */
            inputBar: true,
        },
    }

    platformDefaults = { }
}
