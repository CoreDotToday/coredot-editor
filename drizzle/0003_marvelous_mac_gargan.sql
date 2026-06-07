CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`ai_provider` text DEFAULT 'stub' NOT NULL,
	`ai_model` text DEFAULT 'stub-editor' NOT NULL,
	`ai_base_url` text,
	`ai_max_completion_tokens` integer,
	`ai_reasoning_effort` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "app_settings_ai_provider_check" CHECK("app_settings"."ai_provider" in ('stub', 'openai', 'coredot')),
	CONSTRAINT "app_settings_ai_reasoning_effort_check" CHECK("app_settings"."ai_reasoning_effort" is null or "app_settings"."ai_reasoning_effort" in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')),
	CONSTRAINT "app_settings_ai_max_completion_tokens_check" CHECK("app_settings"."ai_max_completion_tokens" is null or "app_settings"."ai_max_completion_tokens" > 0)
);
