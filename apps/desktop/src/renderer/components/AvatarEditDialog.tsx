import {
  AVATAR_COLOR_COUNT,
  AVATAR_FACES,
  AVATAR_SHAPES,
  avatarCssColor,
  type BotAvatar,
} from "@bebots/domain";
import { Dialog } from "./Dialog";
import { BotAvatar as BotAvatarView } from "./avatar";

interface AvatarEditDialogProps {
  readonly open: boolean;
  readonly value: BotAvatar;
  readonly onChange: (next: BotAvatar) => void;
  readonly onClose: () => void;
}

const SHAPE_LABELS: Record<string, string> = {
  circle: "Circle",
  squircle: "Squircle",
  "rounded-star": "Star",
};

/** Face / color / shape pickers. Closing the dialog commits the avatar. */
export function AvatarEditDialog({ open, value, onChange, onClose }: AvatarEditDialogProps) {
  return (
    <Dialog open={open} title="Edit avatar" onClose={onClose}>
      <div className="avatar-edit">
        <div className="avatar-edit-preview">
          <BotAvatarView avatar={value} size={72} />
        </div>

        <fieldset className="avatar-edit-fieldset">
          <legend>Face</legend>
          <div className="avatar-edit-options">
            {AVATAR_FACES.map((face) => (
              <button
                key={face}
                type="button"
                className={
                  "avatar-edit-swatch" + (value.face === face ? " avatar-edit-swatch-selected" : "")
                }
                aria-label={face}
                aria-pressed={value.face === face}
                onClick={() => onChange({ ...value, face })}
              >
                <BotAvatarView avatar={{ ...value, face }} size={36} />
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="avatar-edit-fieldset">
          <legend>Color</legend>
          <div className="avatar-edit-options">
            {Array.from({ length: AVATAR_COLOR_COUNT }, (_, color) => (
              <button
                key={color}
                type="button"
                className={
                  "avatar-edit-color" + (value.color === color ? " avatar-edit-color-selected" : "")
                }
                style={{ backgroundColor: avatarCssColor(color) }}
                aria-label={`Color ${color}`}
                aria-pressed={value.color === color}
                onClick={() => onChange({ ...value, color })}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="avatar-edit-fieldset">
          <legend>Shape</legend>
          <div className="avatar-edit-options">
            {AVATAR_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                className={
                  "avatar-edit-swatch" + (value.shape === shape ? " avatar-edit-swatch-selected" : "")
                }
                aria-label={SHAPE_LABELS[shape] ?? shape}
                aria-pressed={value.shape === shape}
                onClick={() => onChange({ ...value, shape })}
              >
                <BotAvatarView avatar={{ ...value, shape }} size={36} />
              </button>
            ))}
          </div>
        </fieldset>

        <div className="dialog-actions">
          <button type="button" className="pill-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}
