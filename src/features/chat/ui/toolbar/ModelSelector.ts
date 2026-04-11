import type { ProviderChatUIConfig, ProviderIconSvg } from '@/core/providers/types';

export interface ModelSelectorSettings {
  model: string;
  [key: string]: unknown;
}

export interface ModelSelectorCallbacks {
  onModelChange: (model: string) => Promise<void>;
  getSettings: () => ModelSelectorSettings;
  getEnvironmentVariables?: () => string;
  getUIConfig: () => ProviderChatUIConfig;
}

export class ModelSelector {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ModelSelectorCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ModelSelectorCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-model-selector' });
    this.render();
  }

  private getAvailableModels() {
    const settings = this.callbacks.getSettings();
    const uiConfig = this.callbacks.getUIConfig();
    return uiConfig.getModelOptions({
      ...settings,
      environmentVariables: this.callbacks.getEnvironmentVariables?.(),
    });
  }

  private render() {
    this.container.empty();

    this.buttonEl = this.container.createDiv({ cls: 'claudian-model-btn' });
    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-model-dropdown' });
    this.renderOptions();
  }

  updateDisplay() {
    if (!this.buttonEl) return;
    const currentModel = this.callbacks.getSettings().model;
    const models = this.getAvailableModels();
    const modelInfo = models.find(m => m.value === currentModel);

    const displayModel = modelInfo || models[0];

    this.buttonEl.empty();

    const labelEl = this.buttonEl.createSpan({ cls: 'claudian-model-label' });
    labelEl.setText(displayModel?.label || 'Unknown');
  }

  renderOptions() {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    const currentModel = this.callbacks.getSettings().model;
    const models = this.getAvailableModels();
    const reversed = [...models].reverse();

    let lastGroup: string | undefined;
    for (const model of reversed) {
      if (model.group && model.group !== lastGroup) {
        const separator = this.dropdownEl.createDiv({ cls: 'claudian-model-group' });
        separator.setText(model.group);
        lastGroup = model.group;
      }

      const option = this.dropdownEl.createDiv({ cls: 'claudian-model-option' });
      if (model.value === currentModel) {
        option.addClass('selected');
      }

      const icon = model.providerIcon ?? this.callbacks.getUIConfig().getProviderIcon?.();
      if (icon) {
        option.appendChild(createProviderIconSvg(icon));
      }
      option.createSpan({ text: model.label });
      if (model.description) {
        option.setAttribute('title', model.description);
      }

      option.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onModelChange(model.value);
        this.updateDisplay();
        this.renderOptions();
      });
    }
  }
}

function createProviderIconSvg(icon: ProviderIconSvg): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', icon.viewBox);
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.classList.add('claudian-model-provider-icon');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', icon.path);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}