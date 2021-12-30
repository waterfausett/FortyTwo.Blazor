using FortyTwo.Shared.Models;

namespace FortyTwo.Shared.DTO
{
    public class Hand
    {
        public string PlayerId { get; set; }
        public int TeamId { get; set; }
        public int Dominos { get; set; }
        public Bid? Bid { get; set; }
    }
}
