import { ChangeDetectionStrategy, Component, inject, input, model, signal } from '@angular/core';
import { EditSession } from '../../../core/editing/edit-session';
import { StudioTool } from '../studio-tool';

/** Parameter strip for the active local tool (brush size, amounts, apply). */
@Component({
  selector: 'app-tool-options',
  templateUrl: './tool-options.html',
  styleUrl: './tool-options.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolOptions {
  readonly session = inject(EditSession);
  readonly tool = input<StudioTool | null>(null);
  /** Shared with the viewport — heal/liquify brushes read the same size. */
  readonly brushSize = model(40);

  readonly brightness = signal(0);
  readonly contrast = signal(0);
  readonly saturation = signal(0);
  readonly amount = signal(50);

  async applyAdjust(): Promise<void> {
    await this.session.apply('adjust', {
      brightness: this.brightness(),
      contrast: this.contrast(),
      saturation: this.saturation(),
    });
    this.brightness.set(0);
    this.contrast.set(0);
    this.saturation.set(0);
  }

  async applySharpen(): Promise<void> {
    await this.session.apply('sharpen', this.amount());
  }

  async applySmooth(): Promise<void> {
    await this.session.apply('smooth', this.amount());
  }

  async applyRotate(): Promise<void> {
    await this.session.apply('rotate90', null);
  }
}
