import { isCatchHintVisible, isControlsHintVisible, isFlightModeActive } from '@modules/flightMode'
import ReactEcs, { Label, ReactEcsRenderer, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'

export function setupUi() {
    ReactEcsRenderer.setUiRenderer(uiComponent)
}

// "Press E to Catch" prompt while flying the falcon close to a pigeon
// (visibility is driven by the catch system in assets/scripts/pigeonBird.ts)
const createCatchHintUI = () =>
    isCatchHintVisible() ? (
        <UiEntity
            uiTransform={{
                positionType: 'absolute',
                position: { bottom: '10%', left: 0 },
                width: '100%',
                height: 80,
                justifyContent: 'center',
                alignItems: 'center'
            }}
        >
            <UiEntity
                uiTransform={{
                    width: 'auto',
                    height: 'auto',
                    padding: { top: 14, bottom: 14, left: 44, right: 44 },
                    justifyContent: 'center',
                    alignItems: 'center'
                }}
                uiBackground={{ color: Color4.create(0.78, 0.05, 0.05, 0.95) }}
            >
                <Label
                    value="Press E to Catch"
                    fontSize={38}
                    color={Color4.White()}
                    textAlign="middle-center"
                    uiTransform={{ width: 340, height: 46 }}
                />
            </UiEntity>
        </UiEntity>
    ) : null

// falcon controls panel, bottom-right: shown from falcon activation until 10s
// into the first flight (timing driven by FalconController)
const KEY_COLOR = Color4.create(1, 0.82, 0.3, 1)
const GOAL_COLOR = Color4.create(1, 0.45, 0.4, 1)
const CONTROL_ROWS: Array<{ key: string; action: string }> = [
    { key: 'Shift / Space', action: 'Take off' },
    { key: 'WASD', action: 'Steer' },
    { key: 'Hold Shift', action: 'Flap to speed up' },
    { key: 'Hold Space', action: 'Divebomb' },
    { key: 'E', action: 'Catch a nearby pigeon' }
]

const createFalconControlsUI = () =>
    isControlsHintVisible() ? (
        <UiEntity
            uiTransform={{
                positionType: 'absolute',
                position: { bottom: 32, right: 32 },
                width: 380,
                flexDirection: 'column',
                padding: { top: 18, bottom: 18, left: 22, right: 22 }
            }}
            uiBackground={{ color: Color4.create(0.02, 0.02, 0.05, 0.82) }}
        >
            <Label
                value="RIDING THE FALCON"
                fontSize={24}
                color={Color4.White()}
                textAlign="middle-left"
                uiTransform={{ width: '100%', height: 34, margin: { bottom: 8 } }}
            />
            {CONTROL_ROWS.map((row) => (
                <UiEntity
                    key={row.key}
                    uiTransform={{ width: '100%', height: 30, flexDirection: 'row' }}
                >
                    <Label
                        value={row.key}
                        fontSize={18}
                        color={KEY_COLOR}
                        textAlign="middle-left"
                        uiTransform={{ width: 130, height: 30 }}
                    />
                    <Label
                        value={row.action}
                        fontSize={18}
                        color={Color4.White()}
                        textAlign="middle-left"
                        uiTransform={{ width: 206, height: 30 }}
                    />
                </UiEntity>
            ))}
            <Label
                value="Chase the flying pigeons — catching one is tough!"
                fontSize={17}
                color={GOAL_COLOR}
                textAlign="middle-left"
                textWrap="wrap"
                uiTransform={{ width: '100%', height: 40, margin: { top: 8 } }}
            />
        </UiEntity>
    ) : null

const uiComponent = () => (isFlightModeActive() ? [createCatchHintUI(), createFalconControlsUI()] : [])
