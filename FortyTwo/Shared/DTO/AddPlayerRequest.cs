using FortyTwo.Shared.Models;

namespace FortyTwo.Shared.DTO
{
    public class AddPlayerRequest
    {
        public Teams Team { get; set; }
        public int Position { get; set; }
    }
}
