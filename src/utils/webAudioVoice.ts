import type { VoiceSettings } from "../types";

// Sample-accurate dual-tap granular pitch shifter + vocal isolation + ring-mod robot + adversarial audio perturbation AudioWorklet code
const WORKLET_CODE = `
class VoiceChangerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitchSemitones", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: "k-rate" },
      { name: "robotAmount", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "advAmount", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "isoAmount", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }
    ];
  }

  constructor() {
    super();
    this.bufSize = 8192;
    this.mask = this.bufSize - 1;
    this.grainSize = 2048;
    this.buffers = [new Float32Array(this.bufSize), new Float32Array(this.bufSize)];
    this.writeIndex = 0;
    this.phase = 0;
    this.robotPhase = 0;

    // Vocal isolation / background suppression state
    this.isoLp = [0, 0];
    this.isoEnv = 0;

    // Adversarial audio perturbation state
    this.advBufSize = 16;
    this.advMask = 15;
    this.advBuffers = [new Float32Array(16), new Float32Array(16)];
    this.advWriteIndex = 0;
    this.advSeed = 0x13572468;
    this.advPrevNoise = [0, 0];
    this.advPhase = 0;
    this.advJitterPhase = 0;
  }

  readTap(buf, delaySamples) {
    const pos = this.writeIndex - delaySamples;
    const i0 = Math.floor(pos) & this.mask;
    const i1 = (i0 + 1) & this.mask;
    const frac = pos - Math.floor(pos);
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }

  readAdvTap(buf, delaySamples) {
    const pos = this.advWriteIndex - delaySamples;
    const i0 = Math.floor(pos) & this.advMask;
    const i1 = (i0 + 1) & this.advMask;
    const frac = pos - Math.floor(pos);
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    const pitchSemi = parameters.pitchSemitones[0];
    const robotAmt = parameters.robotAmount[0];
    const advAmt = parameters.advAmount[0];
    const isoAmt = parameters.isoAmount[0];
    const advActive = advAmt > 0.005;
    const isoActive = isoAmt > 0.005;
    const pitchActive = Math.abs(pitchSemi) >= 0.08;
    const ratio = pitchActive ? Math.pow(2, pitchSemi / 12) : 1;
    const phaseInc = pitchActive ? (1 - ratio) / this.grainSize : 0;
    const robotFreq = 58 / sampleRate;
    const jitterFreq = 19 / sampleRate;
    const advPhaseInc = 1 / sampleRate;
    const hpAlpha = Math.exp((-2 * Math.PI * 95) / sampleRate);

    const chCount = Math.min(output.length, 2);
    const frameCount = output[0].length;
    const inCh0 = input[0];
    const inCh1 = input.length > 1 ? input[1] : inCh0;

    for (let i = 0; i < frameCount; i++) {
      let ph = this.phase;
      let dA = ph * this.grainSize;
      let phB = ph + 0.5;
      if (phB >= 1) phB -= 1;
      let dB = phB * this.grainSize;
      // Hann crossfade weights aligned so wA=0 when ph wraps at 0/1 and wB=0 when phB wraps
      const wA = 0.5 * (1 - Math.cos(2 * Math.PI * ph));
      const wB = 1 - wA;

      this.robotPhase += robotFreq;
      if (this.robotPhase >= 1) this.robotPhase -= 1;
      const robotMod = Math.sin(2 * Math.PI * this.robotPhase);

      let advCarrier = 0;
      let dAdv = 2.0;
      if (advActive) {
        this.advJitterPhase += jitterFreq;
        if (this.advJitterPhase >= 1) this.advJitterPhase -= 1;
        dAdv = 2.0 + 1.4 * Math.sin(2 * Math.PI * this.advJitterPhase);

        this.advPhase += advPhaseInc;
        if (this.advPhase >= 1) this.advPhase -= 1;
        const twoPiT = 2 * Math.PI * this.advPhase;
        advCarrier =
          0.45 * Math.sin(twoPiT * 6840) +
          0.35 * Math.sin(twoPiT * 11230) +
          0.2 * Math.sin(twoPiT * 14750 + Math.sin(twoPiT * 37));
      }

      let inL = inCh0[i] || 0;
      let inR = inCh1[i] || 0;

      if (isoActive) {
        const mid = 0.5 * (inL + inR);
        const side = 0.5 * (inL - inR);
        const sideAtten = 1 - isoAmt * 0.88;
        let vL = mid + side * sideAtten;
        let vR = mid - side * sideAtten;

        this.isoLp[0] = hpAlpha * this.isoLp[0] + (1 - hpAlpha) * vL;
        this.isoLp[1] = hpAlpha * this.isoLp[1] + (1 - hpAlpha) * vR;
        const hpL = vL - this.isoLp[0];
        const hpR = vR - this.isoLp[1];
        const hpMix = isoAmt * 0.85;
        vL = vL * (1 - hpMix) + hpL * hpMix;
        vR = vR * (1 - hpMix) + hpR * hpMix;

        const peak = Math.max(Math.abs(vL), Math.abs(vR));
        this.isoEnv = peak > this.isoEnv ? this.isoEnv * 0.96 + peak * 0.04 : this.isoEnv * 0.9992 + peak * 0.0008;
        const gateThresh = 0.014 + isoAmt * 0.026;
        const gateGain =
          this.isoEnv >= gateThresh ? 1 : Math.max(1 - isoAmt * 0.65, this.isoEnv / gateThresh);
        inL = vL * gateGain;
        inR = vR * gateGain;
      }

      for (let ch = 0; ch < chCount; ch++) {
        const x = ch === 0 ? inL : inR;
        const buf = this.buffers[ch];
        buf[this.writeIndex] = x;

        let sample = pitchActive
          ? this.readTap(buf, dA) * wA + this.readTap(buf, dB) * wB
          : x;

        if (robotAmt > 0.01) {
          const ring = sample * robotMod;
          sample = sample * (1 - robotAmt * 0.85) + ring * (robotAmt * 1.15);
        }

        if (advActive) {
          const advBuf = this.advBuffers[ch];
          advBuf[this.advWriteIndex] = sample;
          const micro = this.readAdvTap(advBuf, dAdv);
          const microMix = 0.14 * advAmt;
          sample = sample * (1 - microMix) + micro * microMix;

          this.advSeed = (Math.imul(this.advSeed, 1664525) + 1013904223) >>> 0;
          const rawNoise = ((this.advSeed >>> 16) & 0xffff) / 32767.5 - 1;
          const hfNoise = (rawNoise - this.advPrevNoise[ch]) * 0.5;
          this.advPrevNoise[ch] = rawNoise;

          const mask = Math.min(1, 0.14 + Math.abs(sample) * 2.1);
          const eps = advAmt * 0.026;
          sample += eps * mask * (0.65 * advCarrier + 0.35 * hfNoise);
          if (sample > 0.99) sample = 0.99;
          else if (sample < -0.99) sample = -0.99;
        }

        output[ch][i] = sample;
      }

      this.writeIndex = (this.writeIndex + 1) & this.mask;
      if (advActive) {
        this.advWriteIndex = (this.advWriteIndex + 1) & this.advMask;
      }
      if (pitchActive) {
        ph += phaseInc;
        while (ph < 0) ph += 1;
        while (ph >= 1) ph -= 1;
        this.phase = ph;
      }
    }

    return true;
  }
}

registerProcessor("voice-changer-processor", VoiceChangerProcessor);
`;

const SPECTRAL_PHASE_FREQS = [260, 620, 1280, 2450, 4400, 7600];

const activeContexts = new Set<AudioContext>();

export function resumeAllVoiceContexts(): void {
  activeContexts.forEach((ctx) => {
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  });
}

class RealTimeVoiceProcessor {
  private ctx: AudioContext;
  private source: MediaElementAudioSourceNode;
  private preNode: GainNode;
  private postNode: GainNode;

  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private workletReady = false;
  private latestSettings: VoiceSettings = {
    presetId: "original",
    pitchSemitones: 0,
    speed: 1,
    tone: 0,
    echo: 0,
    robot: 0,
    adversarialNoise: false,
    adversarialStrength: 35,
    spectralPhaseShift: false,
    spectralPhaseStrength: 50,
    vocalIsolation: false,
    vocalIsolationStrength: 65,
  };

  private bassFilter: BiquadFilterNode;
  private trebleFilter: BiquadFilterNode;
  private phaseFilters: BiquadFilterNode[];
  private phaseDryGain: GainNode;
  private phaseWetGain: GainNode;
  private phaseOutNode: GainNode;
  private dryOutGain: GainNode;
  private echoDelay: DelayNode;
  private echoFeedback: GainNode;
  private echoWetGain: GainNode;

  constructor(videoEl: HTMLVideoElement) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();
    activeContexts.add(this.ctx);

    this.source = this.ctx.createMediaElementSource(videoEl);
    this.preNode = this.ctx.createGain();
    this.postNode = this.ctx.createGain();

    // Direct bypass until AudioWorklet loads (<5ms)
    this.source.connect(this.preNode);
    this.preNode.connect(this.postNode);

    // Tone EQ stage
    this.bassFilter = this.ctx.createBiquadFilter();
    this.bassFilter.type = "lowshelf";
    this.bassFilter.frequency.value = 220;

    this.trebleFilter = this.ctx.createBiquadFilter();
    this.trebleFilter.type = "highshelf";
    this.trebleFilter.frequency.value = 3200;

    // Spectral Phase Shifting stage (6-band cascaded all-pass filters with flat magnitude)
    this.phaseDryGain = this.ctx.createGain();
    this.phaseDryGain.gain.value = 1;
    this.phaseWetGain = this.ctx.createGain();
    this.phaseWetGain.gain.value = 0;
    this.phaseOutNode = this.ctx.createGain();
    this.phaseOutNode.gain.value = 1;

    this.phaseFilters = SPECTRAL_PHASE_FREQS.map((freq) => {
      const f = this.ctx.createBiquadFilter();
      f.type = "allpass";
      f.frequency.value = freq;
      f.Q.value = 1.6;
      return f;
    });

    // Echo stage
    this.dryOutGain = this.ctx.createGain();
    this.dryOutGain.gain.value = 1;
    this.echoDelay = this.ctx.createDelay(1.0);
    this.echoDelay.delayTime.value = 0.18;
    this.echoFeedback = this.ctx.createGain();
    this.echoFeedback.gain.value = 0.35;
    this.echoWetGain = this.ctx.createGain();
    this.echoWetGain.gain.value = 0;

    this.postNode.connect(this.bassFilter);
    this.bassFilter.connect(this.trebleFilter);

    // Phase dry/wet routing (mutually switched to avoid comb filtering)
    this.trebleFilter.connect(this.phaseDryGain);
    this.phaseDryGain.connect(this.phaseOutNode);

    this.trebleFilter.connect(this.phaseFilters[0]);
    for (let i = 0; i < this.phaseFilters.length - 1; i++) {
      this.phaseFilters[i].connect(this.phaseFilters[i + 1]);
    }
    this.phaseFilters[this.phaseFilters.length - 1].connect(this.phaseWetGain);
    this.phaseWetGain.connect(this.phaseOutNode);

    this.phaseOutNode.connect(this.dryOutGain);
    this.dryOutGain.connect(this.ctx.destination);

    this.phaseOutNode.connect(this.echoDelay);
    this.echoDelay.connect(this.echoFeedback);
    this.echoFeedback.connect(this.echoDelay);
    this.echoDelay.connect(this.echoWetGain);
    this.echoWetGain.connect(this.ctx.destination);

    this.initPitchProcessor();
  }

  private async initPitchProcessor() {
    if (this.ctx.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        try {
          await this.ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }

        const node = new AudioWorkletNode(this.ctx, "voice-changer-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });

        this.preNode.disconnect(this.postNode);
        this.preNode.connect(node);
        node.connect(this.postNode);
        this.workletNode = node;
        this.workletReady = true;
        this.applySettings(this.latestSettings);
        return;
      } catch {
        // Fall through to ScriptProcessor fallback
      }
    }

    // Fallback for environments without AudioWorklet
    try {
      const bufSize = 8192;
      const mask = bufSize - 1;
      const grainSize = 2048;
      const bufs = [new Float32Array(bufSize), new Float32Array(bufSize)];
      const advBufs = [new Float32Array(16), new Float32Array(16)];
      const advMask = 15;
      let writeIdx = 0;
      let advWriteIdx = 0;
      let phase = 0;
      let robotPhase = 0;
      const isoLp = [0, 0];
      let isoEnv = 0;
      let advSeed = 0x13572468;
      const advPrevNoise = [0, 0];
      let advPhase = 0;
      let advJitterPhase = 0;

      const readTap = (buf: Float32Array, d: number) => {
        const pos = writeIdx - d;
        const i0 = Math.floor(pos) & mask;
        const i1 = (i0 + 1) & mask;
        const frac = pos - Math.floor(pos);
        return buf[i0] * (1 - frac) + buf[i1] * frac;
      };

      const readAdvTap = (buf: Float32Array, d: number) => {
        const pos = advWriteIdx - d;
        const i0 = Math.floor(pos) & advMask;
        const i1 = (i0 + 1) & advMask;
        const frac = pos - Math.floor(pos);
        return buf[i0] * (1 - frac) + buf[i1] * frac;
      };

      const sp = this.ctx.createScriptProcessor(1024, 2, 2);
      sp.onaudioprocess = (ev) => {
        const pitchSemi = this.latestSettings.pitchSemitones;
        const robotAmt = Math.max(0, Math.min(1, this.latestSettings.robot / 100));
        const advAmt = this.latestSettings.adversarialNoise
          ? Math.max(0.05, Math.min(1, (this.latestSettings.adversarialStrength || 35) / 100))
          : 0;
        const isoAmt = this.latestSettings.vocalIsolation
          ? Math.max(0.1, Math.min(1, (this.latestSettings.vocalIsolationStrength || 65) / 100))
          : 0;
        const advActive = advAmt > 0.005;
        const isoActive = isoAmt > 0.005;
        const pitchActive = Math.abs(pitchSemi) >= 0.08;
        const ratio = pitchActive ? Math.pow(2, pitchSemi / 12) : 1;
        const phaseInc = pitchActive ? (1 - ratio) / grainSize : 0;
        const robotFreq = 58 / this.ctx.sampleRate;
        const jitterFreq = 19 / this.ctx.sampleRate;
        const advPhaseInc = 1 / this.ctx.sampleRate;
        const hpAlpha = Math.exp((-2 * Math.PI * 95) / this.ctx.sampleRate);

        const inL = ev.inputBuffer.getChannelData(0);
        const inR = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : inL;
        const outL = ev.outputBuffer.getChannelData(0);
        const outR = ev.outputBuffer.getChannelData(1);

        for (let i = 0; i < inL.length; i++) {
          let ph = phase;
          const dA = ph * grainSize;
          let phB = ph + 0.5;
          if (phB >= 1) phB -= 1;
          const dB = phB * grainSize;
          const wA = 0.5 * (1 - Math.cos(2 * Math.PI * ph));
          const wB = 1 - wA;

          robotPhase += robotFreq;
          if (robotPhase >= 1) robotPhase -= 1;
          const mod = Math.sin(2 * Math.PI * robotPhase);

          let advCarrier = 0;
          let dAdv = 2.0;
          if (advActive) {
            advJitterPhase += jitterFreq;
            if (advJitterPhase >= 1) advJitterPhase -= 1;
            dAdv = 2.0 + 1.4 * Math.sin(2 * Math.PI * advJitterPhase);

            advPhase += advPhaseInc;
            if (advPhase >= 1) advPhase -= 1;
            const twoPiT = 2 * Math.PI * advPhase;
            advCarrier =
              0.45 * Math.sin(twoPiT * 6840) +
              0.35 * Math.sin(twoPiT * 11230) +
              0.2 * Math.sin(twoPiT * 14750 + Math.sin(twoPiT * 37));
          }

          let rawL = inL[i];
          let rawR = inR[i];
          if (isoActive) {
            const mid = 0.5 * (rawL + rawR);
            const side = 0.5 * (rawL - rawR);
            const sideAtten = 1 - isoAmt * 0.88;
            let vL = mid + side * sideAtten;
            let vR = mid - side * sideAtten;

            isoLp[0] = hpAlpha * isoLp[0] + (1 - hpAlpha) * vL;
            isoLp[1] = hpAlpha * isoLp[1] + (1 - hpAlpha) * vR;
            const hpMix = isoAmt * 0.85;
            vL = vL * (1 - hpMix) + (vL - isoLp[0]) * hpMix;
            vR = vR * (1 - hpMix) + (vR - isoLp[1]) * hpMix;

            const peak = Math.max(Math.abs(vL), Math.abs(vR));
            isoEnv = peak > isoEnv ? isoEnv * 0.96 + peak * 0.04 : isoEnv * 0.9992 + peak * 0.0008;
            const gateThresh = 0.014 + isoAmt * 0.026;
            const gateGain = isoEnv >= gateThresh ? 1 : Math.max(1 - isoAmt * 0.65, isoEnv / gateThresh);
            rawL = vL * gateGain;
            rawR = vR * gateGain;
          }

          bufs[0][writeIdx] = rawL;
          bufs[1][writeIdx] = rawR;

          let sL = pitchActive ? readTap(bufs[0], dA) * wA + readTap(bufs[0], dB) * wB : rawL;
          let sR = pitchActive ? readTap(bufs[1], dA) * wA + readTap(bufs[1], dB) * wB : rawR;

          if (robotAmt > 0.01) {
            sL = sL * (1 - robotAmt * 0.85) + sL * mod * (robotAmt * 1.15);
            sR = sR * (1 - robotAmt * 0.85) + sR * mod * (robotAmt * 1.15);
          }

          if (advActive) {
            advBufs[0][advWriteIdx] = sL;
            advBufs[1][advWriteIdx] = sR;
            const microMix = 0.14 * advAmt;
            sL = sL * (1 - microMix) + readAdvTap(advBufs[0], dAdv) * microMix;
            sR = sR * (1 - microMix) + readAdvTap(advBufs[1], dAdv) * microMix;

            const eps = advAmt * 0.026;
            advSeed = (Math.imul(advSeed, 1664525) + 1013904223) >>> 0;
            const nL = ((advSeed >>> 16) & 0xffff) / 32767.5 - 1;
            const hfL = (nL - advPrevNoise[0]) * 0.5;
            advPrevNoise[0] = nL;
            const maskL = Math.min(1, 0.14 + Math.abs(sL) * 2.1);
            sL = Math.max(-0.99, Math.min(0.99, sL + eps * maskL * (0.65 * advCarrier + 0.35 * hfL)));

            advSeed = (Math.imul(advSeed, 1664525) + 1013904223) >>> 0;
            const nR = ((advSeed >>> 16) & 0xffff) / 32767.5 - 1;
            const hfR = (nR - advPrevNoise[1]) * 0.5;
            advPrevNoise[1] = nR;
            const maskR = Math.min(1, 0.14 + Math.abs(sR) * 2.1);
            sR = Math.max(-0.99, Math.min(0.99, sR + eps * maskR * (0.65 * advCarrier + 0.35 * hfR)));

            advWriteIdx = (advWriteIdx + 1) & advMask;
          }

          outL[i] = sL;
          outR[i] = sR;

          writeIdx = (writeIdx + 1) & mask;
          if (pitchActive) {
            ph += phaseInc;
            while (ph < 0) ph += 1;
            while (ph >= 1) ph -= 1;
            phase = ph;
          }
        }
      };

      this.preNode.disconnect(this.postNode);
      this.preNode.connect(sp);
      sp.connect(this.postNode);
      this.scriptNode = sp;
      this.workletReady = true;
    } catch {
      // Keep clean bypass
    }
  }

  public resume() {
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
  }

  public applySettings(settings: VoiceSettings) {
    this.latestSettings = { ...settings };
    const now = this.ctx.currentTime;

    if (this.workletReady && this.workletNode) {
      const pitchParam = this.workletNode.parameters.get("pitchSemitones");
      const robotParam = this.workletNode.parameters.get("robotAmount");
      const advParam = this.workletNode.parameters.get("advAmount");
      const isoParam = this.workletNode.parameters.get("isoAmount");
      pitchParam?.setValueAtTime(settings.pitchSemitones, now);
      robotParam?.setValueAtTime(Math.max(0, Math.min(1, settings.robot / 100)), now);
      advParam?.setValueAtTime(
        settings.adversarialNoise
          ? Math.max(0.05, Math.min(1, (settings.adversarialStrength || 35) / 100))
          : 0,
        now
      );
      isoParam?.setValueAtTime(
        settings.vocalIsolation
          ? Math.max(0.1, Math.min(1, (settings.vocalIsolationStrength || 65) / 100))
          : 0,
        now
      );
    }

    // Tone shaping
    const bassDb = settings.tone < 0 ? Math.abs(settings.tone) * 1.3 : -settings.tone * 0.45;
    const trebleDb = settings.tone > 0 ? settings.tone * 1.3 : -Math.abs(settings.tone) * 0.35;
    this.bassFilter.gain.setTargetAtTime(bassDb, now, 0.02);
    this.trebleFilter.gain.setTargetAtTime(trebleDb, now, 0.02);

    // Spectral Phase Shifting (6-band all-pass cascade)
    if (settings.spectralPhaseShift) {
      const phaseAmt = Math.max(
        0.1,
        Math.min(1, (settings.spectralPhaseStrength || 50) / 100)
      );
      const qVal = 0.6 + phaseAmt * 3.4;
      const freqScale = 0.88 + phaseAmt * 0.24;
      this.phaseDryGain.gain.setTargetAtTime(0, now, 0.02);
      this.phaseWetGain.gain.setTargetAtTime(1, now, 0.02);
      this.phaseFilters.forEach((f, idx) => {
        f.frequency.setTargetAtTime(SPECTRAL_PHASE_FREQS[idx] * freqScale, now, 0.02);
        f.Q.setTargetAtTime(qVal, now, 0.02);
      });
    } else {
      this.phaseDryGain.gain.setTargetAtTime(1, now, 0.02);
      this.phaseWetGain.gain.setTargetAtTime(0, now, 0.02);
    }

    // Echo wet mix & feedback
    const echoAmt = Math.max(0, Math.min(1, settings.echo / 100));
    this.echoDelay.delayTime.setTargetAtTime(0.08 + echoAmt * 0.16, now, 0.02);
    this.echoFeedback.gain.setTargetAtTime(0.15 + echoAmt * 0.45, now, 0.02);
    this.echoWetGain.gain.setTargetAtTime(echoAmt * 0.65, now, 0.02);
  }
}

const processorMap = new WeakMap<HTMLVideoElement, RealTimeVoiceProcessor>();

export function applyVoiceEffectsToVideoElement(
  videoEl: HTMLVideoElement,
  settings: VoiceSettings,
  isPlaying: boolean
): void {
  let proc = processorMap.get(videoEl);
  if (!proc) {
    try {
      proc = new RealTimeVoiceProcessor(videoEl);
      processorMap.set(videoEl, proc);
    } catch {
      return;
    }
  }
  if (isPlaying) {
    proc.resume();
  }
  proc.applySettings(settings);
}
