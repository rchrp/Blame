import { PersonalizationSlider } from "@/components/personalization/personalization-slider"
import {
  SettingsGroup,
  SettingsPanel,
} from "@/pages/settings/settings-layout"
import { personalizationOrder } from "@/lib/personalization"
import { usePersonalization } from "@/lib/use-personalization"

// The settings of the account: they apply to every story and conversation.
export function PersonalizationSettingsPanel() {
  const { change, personalization, ready } = usePersonalization()

  return (
    <SettingsPanel>
      <SettingsGroup
        title="Personalization"
        description="How your agents talk and work. Response style, Experience and Autonomy apply everywhere. Ambition is the default for new stories and conversations, and can be changed for one of them from the composer."
      >
        <div className="grid">
          {personalizationOrder.map((setting) => (
            <div key={setting} className="border-b py-4 last:border-b-0">
              <PersonalizationSlider
                disabled={!ready}
                setting={setting}
                value={personalization[setting]}
                onChange={(value) => void change(setting, value)}
              />
            </div>
          ))}
        </div>
      </SettingsGroup>
    </SettingsPanel>
  )
}


