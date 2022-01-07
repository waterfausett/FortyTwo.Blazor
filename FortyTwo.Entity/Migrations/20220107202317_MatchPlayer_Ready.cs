using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FortyTwo.Entity.Migrations
{
    public partial class MatchPlayer_Ready : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "is_ready",
                table: "match_players",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "is_ready",
                table: "match_players");
        }
    }
}
