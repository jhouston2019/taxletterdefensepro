-- Guest wizard funnel: allow jobs before login (email captured on step 2).
-- Production had NOT NULL on user_id; repo migration originally allowed null.

ALTER TABLE public.tax_letter_jobs
  ALTER COLUMN user_id DROP NOT NULL;
