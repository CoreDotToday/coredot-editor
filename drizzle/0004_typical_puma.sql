PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_provider` text DEFAULT 'stub' NOT NULL,
	`ai_model` text DEFAULT 'stub-editor' NOT NULL,
	`ai_base_url` text,
	`ai_max_completion_tokens` integer,
	`ai_reasoning_effort` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "app_settings_ai_provider_check" CHECK("__new_app_settings"."ai_provider" in ('stub', 'openai', 'coredot', 'anthropic', 'gemini')),
	CONSTRAINT "app_settings_ai_reasoning_effort_check" CHECK("__new_app_settings"."ai_reasoning_effort" is null or "__new_app_settings"."ai_reasoning_effort" in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')),
	CONSTRAINT "app_settings_ai_max_completion_tokens_check" CHECK("__new_app_settings"."ai_max_completion_tokens" is null or "__new_app_settings"."ai_max_completion_tokens" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_app_settings`("id", "ai_provider", "ai_model", "ai_base_url", "ai_max_completion_tokens", "ai_reasoning_effort", "created_at", "updated_at") SELECT "id", "ai_provider", "ai_model", "ai_base_url", "ai_max_completion_tokens", "ai_reasoning_effort", "created_at", "updated_at" FROM `app_settings`;--> statement-breakpoint
DROP TABLE `app_settings`;--> statement-breakpoint
ALTER TABLE `__new_app_settings` RENAME TO `app_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;