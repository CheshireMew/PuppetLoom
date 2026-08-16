import type { MotionChainState } from "@puppetloom/core/browser";

interface ChainParticle {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

export interface SecondaryChainProfile {
  segments: number;
  stiffness: number;
  damping: number;
  propagation: number;
  maxDisplacement: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export class SegmentedSpringChain {
  private readonly particles: ChainParticle[];
  private readonly profile: SecondaryChainProfile;

  constructor(profile: SecondaryChainProfile) {
    this.profile = profile;
    this.particles = Array.from({ length: Math.max(2, profile.segments) }, () => ({
      x: 0,
      y: 0,
      velocityX: 0,
      velocityY: 0
    }));
  }

  reset(): void {
    for (const particle of this.particles) {
      particle.x = 0;
      particle.y = 0;
      particle.velocityX = 0;
      particle.velocityY = 0;
    }
  }

  advance(targetX: number, targetY: number, delta: number): void {
    const safeDelta = clamp(delta, 1 / 240, 1 / 20);
    for (let index = 0; index < this.particles.length; index += 1) {
      const particle = this.particles[index]!;
      const parent = index === 0 ? undefined : this.particles[index - 1]!;
      const depth = this.particles.length <= 1 ? 0 : index / (this.particles.length - 1);
      const feedForward = 0.22 + depth * 0.08;
      const driverGain = 1 + depth * 0.18;
      const desiredX = parent
        ? parent.x * this.profile.propagation * (1 - feedForward) + targetX * driverGain * feedForward
        : targetX;
      const desiredY = parent
        ? parent.y * this.profile.propagation * (1 - feedForward) + targetY * driverGain * feedForward
        : targetY;
      const stiffness = this.profile.stiffness * (1 - depth * 0.32);
      const damping = this.profile.damping * (1 - depth * 0.18);
      particle.velocityX += ((desiredX - particle.x) * stiffness - particle.velocityX * damping) * safeDelta;
      particle.velocityY += ((desiredY - particle.y) * stiffness - particle.velocityY * damping) * safeDelta;
      particle.x = clamp(particle.x + particle.velocityX * safeDelta, -this.profile.maxDisplacement, this.profile.maxDisplacement);
      particle.y = clamp(particle.y + particle.velocityY * safeDelta, -this.profile.maxDisplacement, this.profile.maxDisplacement);
    }
  }

  sample(): MotionChainState {
    return {
      x: this.particles.map((particle) => particle.x),
      y: this.particles.map((particle) => particle.y)
    };
  }
}
