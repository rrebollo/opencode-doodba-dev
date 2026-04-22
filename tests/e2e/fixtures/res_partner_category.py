from odoo import models, fields

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
