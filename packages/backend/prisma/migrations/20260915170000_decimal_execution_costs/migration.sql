DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tasks
    WHERE cost::text IN ('NaN', 'Infinity', '-Infinity')
  ) OR EXISTS (
    SELECT 1 FROM execution_attempts
    WHERE estimated_cost_cny::text IN ('NaN', 'Infinity', '-Infinity')
       OR usage_calculated_cost_cny::text IN ('NaN', 'Infinity', '-Infinity')
       OR billed_cost_cny::text IN ('NaN', 'Infinity', '-Infinity')
  ) THEN
    RAISE EXCEPTION 'NON_FINITE_EXECUTION_COST_REQUIRES_REVIEW';
  END IF;
END $$;

ALTER TABLE tasks
  ALTER COLUMN cost TYPE DECIMAL(18, 6)
  USING ROUND(cost::numeric, 6);

ALTER TABLE execution_attempts
  ALTER COLUMN estimated_cost_cny TYPE DECIMAL(18, 6)
  USING ROUND(estimated_cost_cny::numeric, 6),
  ALTER COLUMN usage_calculated_cost_cny TYPE DECIMAL(18, 6)
  USING ROUND(usage_calculated_cost_cny::numeric, 6),
  ALTER COLUMN billed_cost_cny TYPE DECIMAL(18, 6)
  USING ROUND(billed_cost_cny::numeric, 6);
