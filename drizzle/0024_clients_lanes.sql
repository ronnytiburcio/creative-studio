ALTER TABLE `clients` ADD `hidden_at` integer;--> statement-breakpoint
ALTER TABLE `clients` ADD `campaign_mode` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `clients` ADD `campaign_id` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `leads_mode` text DEFAULT 'meta' NOT NULL;--> statement-breakpoint
ALTER TABLE `clients` ADD `ghl_source` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `folder` text;--> statement-breakpoint
ALTER TABLE `sections` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sections` ADD `campaign_mode` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `sections` ADD `campaign_id` text;--> statement-breakpoint
ALTER TABLE `sections` ADD `leads_mode` text DEFAULT 'meta' NOT NULL;--> statement-breakpoint
ALTER TABLE `sections` ADD `ghl_source` text;--> statement-breakpoint
ALTER TABLE `sections` ADD `ghl_location_id` text;--> statement-breakpoint
-- Creative Studio 1b: every client that exists before this migration was synced by the old fixed rule (the widget's campaign via state.json / the name scan / the only campaign, GHL leads with source `<code>-fb-ad`), so it keeps exactly that. New clients default to every campaign + Meta leads.
UPDATE `clients` SET `campaign_mode` = 'state_json', `leads_mode` = 'ghl', `ghl_source` = `code` || '-fb-ad';--> statement-breakpoint
-- Lane C's own account kept its old rule: every campaign (account-level numbers), Meta leads until a GHL contact carries source `<lane key>-fb-ad`, then GHL leads.
UPDATE `sections` SET `campaign_mode` = 'all', `leads_mode` = 'auto', `ghl_source` = `key` || '-fb-ad' WHERE `key` = 'fkb';
