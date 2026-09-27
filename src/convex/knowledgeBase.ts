import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";

const knowledgeSeed = [
  {
    rtos: "zephyr" as const,
    category: "structure",
    title: "Zephyr Project Layout",
    content: `
A minimal Zephyr application has the following layout:
- CMakeLists.txt: declares project, target board and sources.
- prj.conf: Kconfig fragments for the application.
- boards/<board>.overlay: device tree overlay for extra peripherals (optional).
- src/main.c: application entry point with #include <zephyr/kernel.h>.
- src/<modules>.c/h: driver wrappers and application logic.

Build with: west build -b <board> -p auto
    `.trim(),
    tags: ["zephyr", "west", "build", "layout"],
  },
  {
    rtos: "zephyr" as const,
    category: "pattern",
    title: "Zephyr main.c template",
    content: `
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

int main(void) {
    printk("Hello from Zephyr on %s\\n", CONFIG_BOARD);
    while (1) {
        k_sleep(K_SECONDS(1));
    }
    return 0;
}
    `.trim(),
    tags: ["zephyr", "template", "main", "thread"],
  },
  {
    rtos: "zephyr" as const,
    category: "checklist",
    title: "Zephyr RTOS Checklist",
    content: `
- prj.conf enables the CONFIG_* options needed by the application.
- Device tree overlay matches the board pinmux/aliases.
- CMakeLists.txt finds Zephyr via find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE}).
- Thread stacks are defined statically with K_THREAD_STACK_DEFINE or K_THREAD_DEFINE.
- ISRs stay short and never call blocking kernel APIs; use k_work_submit instead.
- Stack sizes are verified with CONFIG_MAIN_STACK_SIZE.
    `.trim(),
    tags: ["zephyr", "checklist", "isr", "stack"],
  },
  {
    rtos: "zephyr" as const,
    category: "pattern",
    title: "Zephyr GPIO interrupt pattern",
    content: `
static struct gpio_callback button_cb;
static struct k_work button_work;

static void button_work_handler(struct k_work *work) {
    /* deferred, may block */
}

static void button_isr(const struct device *port,
                       struct gpio_callback *cb, uint32_t pins) {
    ARG_UNUSED(port); ARG_UNUSED(cb); ARG_UNUSED(pins);
    k_work_submit(&button_work); /* ISR-safe, no blocking */
}
    `.trim(),
    tags: ["zephyr", "gpio", "isr", "workqueue"],
  },
  {
    rtos: "zephyr" as const,
    category: "pattern",
    title: "Zephyr sensor polling pattern",
    content: `
const struct device *dev = DEVICE_DT_GET(DT_ALIAS(temp0));
struct sensor_value value;

if (!device_is_ready(dev)) {
    printk("sensor not ready\\n");
    return;
}
if (sensor_sample_fetch(dev) == 0) {
    sensor_channel_get(dev, SENSOR_CHAN_AMBIENT_TEMP, &value);
}
    `.trim(),
    tags: ["zephyr", "sensor", "temperature", "devicetree"],
  },
  {
    rtos: "freertos" as const,
    category: "structure",
    title: "FreeRTOS Project Layout",
    content: `
A vendor-agnostic FreeRTOS project typically contains:
- CMakeLists.txt or Makefile: build rules, include paths, source files.
- FreeRTOSConfig.h: kernel configuration (clock, heap, hooks).
- src/main.c: creates tasks, queues, timers, starts scheduler.
- src/app/: application logic separated from hardware.
- src/drivers/: HAL wrappers and low-level drivers.
- tests/: unit tests with mocked kernel APIs.
    `.trim(),
    tags: ["freertos", "build", "layout"],
  },
  {
    rtos: "freertos" as const,
    category: "pattern",
    title: "FreeRTOS static task pattern",
    content: `
#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"

#define TASK_STACK_SIZE 256
#define TASK_PRIORITY   1

static StaticTask_t taskBuffer;
static StackType_t  stackBuffer[TASK_STACK_SIZE];
static TaskHandle_t taskHandle;

static void appTask(void *pvParameters) {
    (void)pvParameters;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void appTaskCreate(void) {
    taskHandle = xTaskCreateStatic(
        appTask, "app", TASK_STACK_SIZE, NULL,
        TASK_PRIORITY, stackBuffer, &taskBuffer);
}
    `.trim(),
    tags: ["freertos", "static", "task", "pattern"],
  },
  {
    rtos: "freertos" as const,
    category: "pattern",
    title: "FreeRTOS ISR to task hand-off",
    content: `
static QueueHandle_t isrQueue;
static BaseType_t higherPriorityTaskWoken;

void EXTI0_IRQHandler(void) {
    uint32_t event = 1;
    xQueueSendToBackFromISR(isrQueue, &event, &higherPriorityTaskWoken);
    portYIELD_FROM_ISR(higherPriorityTaskWoken);
}
    `.trim(),
    tags: ["freertos", "isr", "queue", "fromisr"],
  },
  {
    rtos: "freertos" as const,
    category: "checklist",
    title: "FreeRTOS RTOS Checklist",
    content: `
- FreeRTOSConfig.h matches the MCU and tick frequency.
- Static allocation used where possible (configSUPPORT_STATIC_ALLOCATION).
- ISRs use FromISR API variants only.
- Priority inversion handled with priority inheritance if available.
- Stack overflow checking enabled during development.
- No dynamic memory in deterministic paths.
    `.trim(),
    tags: ["freertos", "checklist", "isr", "stack", "config"],
  },
  {
    rtos: "general" as const,
    category: "best_practice",
    title: "Embedded Safety Rules",
    content: `
- Prefer static allocation; avoid malloc/free in real-time paths.
- Keep ISRs short; defer work to tasks via notifications or queues.
- Use mutexes/semaphores with timeout, never block forever.
- Validate pointer arguments and array bounds.
- Enable watchdog and stack overflow checks.
- Never call non-reentrant libc functions from ISRs.
- Use bounded string APIs (strncpy/snprintf) instead of strcpy/sprintf.
    `.trim(),
    tags: ["safety", "general", "allocation", "isr"],
  },
  {
    rtos: "general" as const,
    category: "workflow",
    title: "Build verification policy",
    content: `
- A build counts as verified ONLY when a real toolchain was executed and exited 0.
- "SIMULATED" and "NOT_AVAILABLE" results never verify a project.
- Capture the exact command, exit code, duration, stdout and stderr for every build.
- On failure, feed the compiler output back to the model and rebuild (max 3 attempts).
    `.trim(),
    tags: ["build", "verification", "policy", "workflow"],
  },
];

export const seedKnowledgeBase = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUserId(ctx);
    const existing = await ctx.db.query("knowledgeBase").take(1);
    if (existing.length > 0) {
      return { inserted: 0, reason: "already seeded" };
    }
    for (const item of knowledgeSeed) {
      await ctx.db.insert("knowledgeBase", item);
    }
    return { inserted: knowledgeSeed.length };
  },
});

export const listByRtos = query({
  args: {
    rtos: v.union(v.literal("freertos"), v.literal("zephyr"), v.literal("general")),
  },
  handler: async (ctx, args) => {
    await requireUserId(ctx);
    return await ctx.db
      .query("knowledgeBase")
      .withIndex("by_rtos_category", (q) => q.eq("rtos", args.rtos))
      .collect();
  },
});

export const listByCategory = query({
  args: {
    rtos: v.union(v.literal("freertos"), v.literal("zephyr"), v.literal("general")),
    category: v.string(),
  },
  handler: async (ctx, args) => {
    await requireUserId(ctx);
    return await ctx.db
      .query("knowledgeBase")
      .withIndex("by_rtos_category", (q) =>
        q.eq("rtos", args.rtos).eq("category", args.category),
      )
      .collect();
  },
});

/** Internal: the documents available for retrieval by the agent. */
export const allDocuments = internalQuery({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("knowledgeBase").take(200);
    return docs.map((doc) => ({
      _id: doc._id as unknown as string,
      rtos: doc.rtos,
      category: doc.category,
      title: doc.title,
      content: doc.content,
      tags: doc.tags ?? [],
    }));
  },
});
