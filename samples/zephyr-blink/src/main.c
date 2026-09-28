/*
 * EmbedFactory reference firmware (Zephyr).
 *
 * This is the minimal, board-agnostic application the runner really compiles
 * to prove the vertical slice works with a real toolchain. It deliberately
 * avoids devicetree aliases, drivers and board-specific headers so it builds
 * unchanged for:
 *
 *   - native_sim        (host build, no cross toolchain needed)
 *   - qemu_cortex_m3    (ARM, needs the Zephyr SDK)
 *   - nucleo_l476rg     (real ARM hardware, needs the Zephyr SDK)
 *
 * A successful build produces build/zephyr/zephyr.elf and, for ARM boards,
 * build/zephyr/zephyr.bin and build/zephyr/zephyr.hex.
 */

#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

int main(void)
{
	printk("EmbedFactory reference firmware starting\n");

	while (1) {
		printk("uptime: %lld ms\n", (long long)k_uptime_get());
		k_sleep(K_SECONDS(1));
	}

	return 0;
}
