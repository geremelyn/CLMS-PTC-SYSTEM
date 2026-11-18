-- CP166 (OPTIONAL, NOT run automatically): store "Julius Codilan" as the name of the MIS Head / Super Admin account.
-- The User Accounts page now shows the account's OWN stored name, so this is only needed if the stored name is still empty or a
-- generic placeholder ("Super Admin", "MIS", "MIS Head", "Admin", "Administrator"). Back up the database first.
--
-- Safety guards (the UPDATE changes nothing unless ALL are true):
--   * exactly ONE account has role MIS (never touches any other account);
--   * that account's full_name is empty or a generic placeholder AND it has no surname / first name saved
--     (a real name that is already stored is never overwritten).
-- Note: full_name is also shown by other screens that print the account's name (for example the Audit Log), so those will show
-- "Julius Codilan" afterwards. Run the SELECT first to see what is stored today.

SELECT id, username, role, full_name, surname, first_name, middle_initial FROM users WHERE role = 'MIS';

UPDATE users
SET full_name = 'Julius Codilan', surname = 'Codilan', first_name = 'Julius', middle_initial = NULL
WHERE role = 'MIS'
  AND (SELECT n FROM (SELECT COUNT(*) AS n FROM users WHERE role = 'MIS') AS only_one) = 1
  AND LOWER(TRIM(COALESCE(full_name, ''))) IN ('', 'super admin', 'mis', 'mis head', 'admin', 'administrator')
  AND TRIM(COALESCE(surname, '')) = ''
  AND TRIM(COALESCE(first_name, '')) = '';
