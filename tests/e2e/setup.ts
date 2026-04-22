import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestFixture {
  rootDir: string;
  doodbaRoot: string;
  sourcePaths: string[];
  dbPath: string;
}

export function createTestFixture(): TestFixture {
  const rootDir = mkdtempSync(join(tmpdir(), "opencode-doodba-dev-e2e-"));
  const doodbaRoot = rootDir;
  const srcDir = join(doodbaRoot, "odoo", "custom", "src");

  // .copier-answers.yml marker
  writeFileSync(join(doodbaRoot, ".copier-answers.yml"), "");

  // === Odoo core repository ===
  const odooRepo = join(srcDir, "odoo");

  // base addon (inside odoo/addons/)
  const baseDir = join(odooRepo, "odoo", "addons", "base");
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(
    join(baseDir, "__manifest__.py"),
    `{
  "name": "base",
  "version": "1.0",
  "depends": [],
  "data": ["views/res_partner_views.xml"]
}`
  );
  mkdirSync(join(baseDir, "models"), { recursive: true });
  writeFileSync(
    join(baseDir, "models", "res_partner.py"),
    `from odoo import models, fields

class ResPartner(models.Model):
    _name = "res.partner"
    _description = "Partner"

    name = fields.Char(string="Name", required=True)
    email = fields.Char(string="Email")
    is_company = fields.Boolean(string="Is Company", default=False)
    active = fields.Boolean(string="Active", default=True)
    phone = fields.Char(string="Phone")
    street = fields.Char(string="Street")
`
  );
  mkdirSync(join(baseDir, "views"), { recursive: true });
  writeFileSync(
    join(baseDir, "views", "res_partner_views.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <record id="view_partner_form" model="ir.ui.view">
        <field name="name">res.partner.form</field>
        <field name="model">res.partner</field>
        <field name="arch" type="xml">
            <form>
                <sheet>
                    <group>
                        <field name="name"/>
                        <field name="email"/>
                        <field name="is_company"/>
                    </group>
                </sheet>
            </form>
        </field>
    </record>
</odoo>`
  );

  // sale addon (inside addons/ — fallback location)
  const saleDir = join(odooRepo, "addons", "sale");
  mkdirSync(saleDir, { recursive: true });
  writeFileSync(
    join(saleDir, "__manifest__.py"),
    `{
  "name": "sale",
  "version": "1.0",
  "depends": ["base"],
  "data": ["views/sale_order_views.xml"]
}`
  );
  mkdirSync(join(saleDir, "models"), { recursive: true });
  writeFileSync(
    join(saleDir, "models", "sale_order.py"),
    `from odoo import models, fields

class SaleOrder(models.Model):
    _name = "sale.order"
    _description = "Sales Order"

    name = fields.Char(string="Order Reference", required=True)
    partner_id = fields.Many2one("res.partner", string="Customer", required=True)
    amount_total = fields.Float(string="Total", readonly=True)
    state = fields.Selection([
        ("draft", "Draft"),
        ("sent", "Sent"),
        ("sale", "Sales Order"),
        ("done", "Locked"),
        ("cancel", "Cancelled")
    ], string="Status", default="draft")
    date_order = fields.Datetime(string="Order Date")
`
  );
  mkdirSync(join(saleDir, "views"), { recursive: true });
  writeFileSync(
    join(saleDir, "views", "sale_order_views.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <record id="view_order_form" model="ir.ui.view">
        <field name="name">sale.order.form</field>
        <field name="model">sale.order</field>
        <field name="arch" type="xml">
            <form>
                <sheet>
                    <group>
                        <field name="name"/>
                        <field name="partner_id"/>
                        <field name="amount_total"/>
                        <field name="state"/>
                    </group>
                </sheet>
            </form>
        </field>
    </record>
</odoo>`
  );

  // === Custom repository (normal structure) ===
  const customRepo = join(srcDir, "custom-repo");

  // partner_firstname addon
  const partnerDir = join(customRepo, "partner_firstname");
  mkdirSync(partnerDir, { recursive: true });
  writeFileSync(
    join(partnerDir, "__manifest__.py"),
    `{
  "name": "partner_firstname",
  "version": "1.0",
  "depends": ["base"],
  "data": []
}`
  );
  mkdirSync(join(partnerDir, "models"), { recursive: true });
  writeFileSync(
    join(partnerDir, "models", "res_partner.py"),
    `from odoo import models, fields

class ResPartner(models.Model):
    _inherit = "res.partner"

    firstname = fields.Char(string="First Name")
    lastname = fields.Char(string="Last Name")
`
  );

  // my_module addon (depends on sale + partner_firstname)
  const myModuleDir = join(customRepo, "my_module");
  mkdirSync(myModuleDir, { recursive: true });
  writeFileSync(
    join(myModuleDir, "__manifest__.py"),
    `{
  "name": "my_module",
  "version": "1.0",
  "depends": ["sale", "partner_firstname"],
  "data": ["views/my_views.xml"]
}`
  );
  mkdirSync(join(myModuleDir, "models"), { recursive: true });
  writeFileSync(
    join(myModuleDir, "models", "my_model.py"),
    `from odoo import models, fields

class MyModel(models.Model):
    _name = "my.model"
    _description = "My Model"

    name = fields.Char(string="Name", required=True)
    order_id = fields.Many2one("sale.order", string="Sale Order")
    quantity = fields.Integer(string="Quantity", default=1)
    price = fields.Float(string="Price")
`
  );

  // partner_category addon (tests multi-class fixture - catches class-body boundary bugs)
  const partnerCategoryDir = join(customRepo, "partner_category");
  mkdirSync(partnerCategoryDir, { recursive: true });
  writeFileSync(
    join(partnerCategoryDir, "__manifest__.py"),
    `{
  "name": "partner_category",
  "version": "1.0",
  "depends": ["base"],
  "data": []
}`
  );
  mkdirSync(join(partnerCategoryDir, "models"), { recursive: true });
  writeFileSync(
    join(partnerCategoryDir, "models", "res_partner_category.py"),
    `from odoo import models, fields

class ResPartnerCategory(models.Model):
    _name = "res.partner.category"
    _description = "Partner Category"

    name = fields.Char(string="Category Name", required=True)
    active = fields.Boolean(string="Active", default=True)
    color = fields.Integer(string="Color", default=0)
    parent_id = fields.Many2one("res.partner.category", string="Parent Category")

class PartnerCategoryHelper(models.TransientModel):
    _name = "partner.category.helper"
    _description = "Partner Category Helper"

    category_id = fields.Many2one("res.partner.category", string="Category", required=True)
    partner_ids = fields.Many2many("res.partner", string="Partners")
    notes = fields.Text(string="Notes")
`
  );
  mkdirSync(join(myModuleDir, "views"), { recursive: true });
  writeFileSync(
    join(myModuleDir, "views", "my_views.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <record id="view_my_model_tree" model="ir.ui.view">
        <field name="name">my.model.tree</field>
        <field name="model">my.model</field>
        <field name="arch" type="xml">
            <tree>
                <field name="name"/>
                <field name="order_id"/>
                <field name="quantity"/>
            </tree>
        </field>
    </record>
</odoo>`
  );

  // === Database path ===
  const dbDir = join(rootDir, ".opencode", "doodba-dev");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "index.db");

  return {
    rootDir,
    doodbaRoot,
    sourcePaths: [odooRepo, customRepo],
    dbPath,
  };
}

export function destroyTestFixture(fixture: TestFixture): void {
  rmSync(fixture.rootDir, { recursive: true });
}
